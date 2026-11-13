"""Tests for the worker-process pool. These start real worker processes."""

import asyncio
import sys
import threading
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest

from notebook_api.query import runner as runner_module
from notebook_api.query.engine import EngineLimits
from notebook_api.query.runner import QueryFailedError, QueryRunner, WorkerStartError
from notebook_api.query.validate import PreparedQuery, QueryRejectedError, prepare_query
from tests.fixtures import exit_immediately

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


async def test_start_reports_a_worker_that_exits_during_startup(
    query_db: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(runner_module, "worker_main", exit_immediately)
    pool = _runner(query_db, tmp_path / "spill")
    with pytest.raises(WorkerStartError, match="exited during startup"):
        await pool.start()
    assert pool._all == set()
    assert list((tmp_path / "spill").glob("worker-*")) == []


async def test_start_reports_the_real_error_when_a_process_cannot_start(
    query_db: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pool = _runner(query_db, tmp_path / "spill")
    real_process = pool._ctx.Process

    def unstartable(*args: Any, **kwargs: Any) -> Any:
        process = real_process(*args, **kwargs)

        def start() -> None:
            raise OSError("too many open files")

        process.start = start  # type: ignore[method-assign]
        return process

    pipes: list[Any] = []
    real_pipe = pool._ctx.Pipe

    def recording_pipe(*args: Any, **kwargs: Any) -> Any:
        ends = real_pipe(*args, **kwargs)
        pipes.extend(ends)
        return ends

    monkeypatch.setattr(pool._ctx, "Process", unstartable)
    monkeypatch.setattr(pool._ctx, "Pipe", recording_pipe)
    with pytest.raises(OSError, match="too many open files"):
        await pool.start()
    assert list((tmp_path / "spill").glob("worker-*")) == []
    # Both ends of every pipe are closed, so failed starts don't leak fds.
    assert pipes and all(conn.closed for conn in pipes)


async def test_start_fails_cleanly_for_a_corrupt_database(tmp_path: Path) -> None:
    bad = tmp_path / "bad.duckdb"
    bad.write_bytes(b"this is not a duckdb file" * 100)
    pool = _runner(bad, tmp_path / "spill")
    with pytest.raises(WorkerStartError, match="failed to start"):
        await pool.start()
    assert pool._all == set()
    assert list((tmp_path / "spill").glob("worker-*")) == []


async def test_sql_is_parsed_off_the_event_loop(
    runner: QueryRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Checks the design property directly: parsing runs on another thread, not
    # the event loop's. (A wall-clock assertion on loop pauses was flaky: GC
    # and GIL contention still cause pauses that vary with machine load.
    # Latency is measured by the Phase 4 benchmark, not asserted here.)
    loop_thread = threading.get_ident()
    parse_threads: list[int] = []

    def recording_prepare(sql: str, row_limit: int) -> PreparedQuery:
        parse_threads.append(threading.get_ident())
        return prepare_query(sql, row_limit)

    monkeypatch.setattr(runner_module, "prepare_query", recording_prepare)
    result = await runner.run("select count(*) as n from nums")
    assert result["rows"] == [[10000]]
    assert parse_threads and all(t != loop_thread for t in parse_threads)


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
