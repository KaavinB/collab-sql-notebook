"""Tests for the worker-process pool. These start real worker processes."""

import asyncio
import sys
import time
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from notebook_api.query import runner as runner_module
from notebook_api.query.engine import EngineLimits
from notebook_api.query.runner import QueryFailedError, QueryRunner, WorkerStartError
from notebook_api.query.validate import QueryRejectedError

pytestmark = pytest.mark.anyio


# Every test here runs on plain asyncio and on uvloop, which is what uvicorn
# uses in production. They differ in how pipes behave (see runner.py).
@pytest.fixture(
    params=[
        pytest.param(("asyncio", {"use_uvloop": False}), id="asyncio"),
        pytest.param(("asyncio", {"use_uvloop": True}), id="uvloop"),
    ]
)
def anyio_backend(request: pytest.FixtureRequest) -> tuple[str, dict[str, bool]]:
    backend: tuple[str, dict[str, bool]] = request.param
    return backend


LIMITS = EngineLimits(
    memory_limit_mb=256,
    process_memory_cap_mb=1024,
    threads=1,
    max_spill_size_mb=100,
    timeout_seconds=0.5,
    row_limit=100,
    max_result_bytes=1_000_000,
)
SLOW = "select sum(a.i * b.i) from nums a, nums b, nums c"


def _runner(db: Path, spill: Path, workers: int = 2, queue_timeout: float = 5.0) -> QueryRunner:
    return QueryRunner(db, spill, LIMITS, workers=workers, queue_timeout_seconds=queue_timeout)


@pytest.fixture
async def runner(query_db: Path, tmp_path: Path) -> AsyncIterator[QueryRunner]:
    pool = _runner(query_db, tmp_path / "spill")
    await pool.start()
    yield pool
    await pool.close()


async def _wait_for_pool_size(pool: QueryRunner, size: int) -> None:
    for _ in range(100):
        if len(pool._all) == size and pool._idle.qsize() == size:
            return
        await asyncio.sleep(0.05)
    raise AssertionError(f"pool did not return to {size} idle workers")


async def test_runs_a_query(runner: QueryRunner) -> None:
    result = await runner.run("select count(*) as n from nums")
    assert result["columns"] == [{"name": "n", "type": "BIGINT"}]
    assert result["rows"] == [[10000]]
    assert result["truncated"] is False
    assert result["duration_ms"] >= 0


@pytest.mark.parametrize("value_bytes", [1_000, 5_000])
async def test_returns_results_larger_than_a_pipe_buffer(
    runner: QueryRunner, value_bytes: int
) -> None:
    # 100 rows of 1 KB / 5 KB: replies of ~100 KB / ~500 KB, well past a pipe
    # buffer (typically 64 KB), so the parent must read them in many chunks.
    result = await runner.run(f"select i, repeat('x', {value_bytes}) as s from nums order by i")
    assert result["row_count"] == 100
    assert result["truncated"] is True
    assert result["rows"][99] == [99, "x" * value_bytes]
    assert len(runner._all) == 2  # no worker was retired


async def test_rejects_invalid_sql_before_using_a_worker(runner: QueryRunner) -> None:
    with pytest.raises(QueryRejectedError):
        await runner.run("drop table nums")
    assert runner._idle.qsize() == 2


async def test_engine_lockdown_applies_inside_workers(runner: QueryRunner) -> None:
    with pytest.raises(QueryFailedError, match="disabled by configuration") as info:
        await runner.run("select * from read_csv('/etc/passwd')")
    assert info.value.kind == "error"


async def test_query_errors_keep_the_worker(runner: QueryRunner) -> None:
    workers_before = set(runner._all)
    with pytest.raises(QueryFailedError) as info:
        await runner.run("select nope from nums")
    assert info.value.kind == "error"
    assert set(runner._all) == workers_before


async def test_cooperative_timeout_keeps_the_worker(runner: QueryRunner) -> None:
    # DuckDB's interrupt stops the query and the worker replies "timeout":
    # its state is known, so it goes back into the pool (D16).
    before = set(runner._all)
    with pytest.raises(QueryFailedError) as info:
        await runner.run(SLOW)
    assert info.value.kind == "timeout"
    assert set(runner._all) == before
    assert (await runner.run("select 1 as x"))["rows"] == [[1]]


async def test_parent_kills_a_worker_that_does_not_answer(
    runner: QueryRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Make the parent's deadline expire before the worker's own interrupt fires,
    # simulating a worker stuck where DuckDB's interrupt can't reach it.
    monkeypatch.setattr(runner_module, "_KILL_GRACE_SECONDS", -0.4)
    before = set(runner._all)
    with pytest.raises(QueryFailedError) as info:
        await runner.run(SLOW)
    assert info.value.kind == "timeout"
    killed = before - set(runner._all)
    assert len(killed) == 1
    monkeypatch.undo()
    await _wait_for_pool_size(runner, 2)
    (worker,) = killed
    assert not worker.process.is_alive()
    assert not worker.spill_dir.exists()
    assert (await runner.run("select 2 as x"))["rows"] == [[2]]


async def test_a_crashed_worker_is_reported_and_replaced(runner: QueryRunner) -> None:
    async def crash_soon() -> None:
        await asyncio.sleep(0.1)
        busy = [w for w in runner._all if w not in runner._idle._queue]  # type: ignore[attr-defined]
        busy[0].process.kill()

    crasher = asyncio.create_task(crash_soon())
    with pytest.raises(QueryFailedError) as info:
        await runner.run(SLOW)
    await crasher
    assert info.value.kind == "crashed"
    await _wait_for_pool_size(runner, 2)
    assert (await runner.run("select 3 as x"))["rows"] == [[3]]


async def test_a_cancelled_request_never_leaks_its_result_to_the_next_one(
    query_db: Path, tmp_path: Path
) -> None:
    pool = _runner(query_db, tmp_path / "spill", workers=1)
    await pool.start()
    try:
        # Without the fix, the worker's late reply to this query would be read
        # as the answer to the next one.
        task = asyncio.create_task(pool.run(SLOW))
        await asyncio.sleep(0.1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await _wait_for_pool_size(pool, 1)
        result = await pool.run("select 'fresh' as v")
        assert result["rows"] == [["fresh"]]
    finally:
        await pool.close()


async def test_refuses_as_busy_when_no_worker_frees_up(query_db: Path, tmp_path: Path) -> None:
    pool = _runner(query_db, tmp_path / "spill", workers=1, queue_timeout=0.1)
    await pool.start()
    try:
        slow = asyncio.create_task(pool.run(SLOW))
        await asyncio.sleep(0.05)
        with pytest.raises(QueryFailedError) as info:
            await pool.run("select 1")
        assert info.value.kind == "busy"
        with pytest.raises(QueryFailedError):
            await slow
    finally:
        await pool.close()


async def test_concurrent_queries_share_the_pool(runner: QueryRunner) -> None:
    results = await asyncio.gather(*(runner.run(f"select {i} as x") for i in range(8)))
    assert sorted(str(r["rows"][0][0]) for r in results) == [str(i) for i in range(8)]


async def test_start_cleans_stale_worker_spill_dirs_only(query_db: Path, tmp_path: Path) -> None:
    spill = tmp_path / "spill"
    (spill / "worker-dead").mkdir(parents=True)
    (spill / "worker-dead" / "block.tmp").write_bytes(b"x")
    (spill / "keep-me").write_text("not ours")
    pool = _runner(query_db, spill)
    await pool.start()
    try:
        assert not (spill / "worker-dead").exists()
        assert (spill / "keep-me").read_text() == "not ours"
        assert len(list(spill.glob("worker-*"))) == 2
    finally:
        await pool.close()
    assert list(spill.glob("worker-*")) == []


async def test_start_fails_for_a_missing_database(tmp_path: Path) -> None:
    pool = _runner(tmp_path / "missing.duckdb", tmp_path / "spill")
    with pytest.raises(FileNotFoundError, match="pnpm ingest"):
        await pool.start()


async def test_start_fails_cleanly_for_a_corrupt_database(tmp_path: Path) -> None:
    bad = tmp_path / "bad.duckdb"
    bad.write_bytes(b"this is not a duckdb file" * 100)
    pool = _runner(bad, tmp_path / "spill")
    with pytest.raises(WorkerStartError, match="failed to start"):
        await pool.start()
    assert pool._all == set()
    assert list((tmp_path / "spill").glob("worker-*")) == []


async def test_parsing_a_large_query_does_not_block_the_event_loop(runner: QueryRunner) -> None:
    big = "select * from nums where i in (" + ",".join(str(i) for i in range(3000)) + ")"
    gaps: list[float] = []

    async def heartbeat() -> None:
        last = time.perf_counter()
        while True:
            await asyncio.sleep(0.005)
            now = time.perf_counter()
            gaps.append(now - last)
            last = now

    beat = asyncio.create_task(heartbeat())
    await asyncio.gather(*(runner.run(big) for _ in range(3)))
    beat.cancel()
    # The loop kept ticking while three large queries were parsed. The GIL means
    # some delay, but nothing like the parse time itself.
    assert max(gaps) < 0.25


@pytest.mark.skipif(sys.platform != "linux", reason="RLIMIT_DATA is only enforced on Linux")
async def test_worker_memory_cap_turns_huge_values_into_errors(
    query_db: Path, tmp_path: Path
) -> None:
    # One 30M-element list is built outside DuckDB's buffer manager, so only
    # the process cap (1024 MB here) stops it. A long timeout makes sure it's
    # the memory cap, not the timeout, that ends the query.
    limits = EngineLimits(**{**LIMITS.__dict__, "timeout_seconds": 60.0})
    pool = QueryRunner(query_db, tmp_path / "spill", limits, workers=1, queue_timeout_seconds=5)
    await pool.start()
    try:
        with pytest.raises(QueryFailedError, match="more memory") as info:
            await pool.run("select range(30000000) as r")
        assert info.value.kind == "error"
        assert (await pool.run("select 4 as x"))["rows"] == [[4]]
    finally:
        await pool.close()
