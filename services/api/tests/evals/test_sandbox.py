"""The eval's query processes: killed when they overrun, scrubbed environment, reuse."""

import json
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from notebook_api.evals import sandbox
from notebook_api.evals.sandbox import SandboxPool, sqlite_job
from notebook_api.evals.taxi import DuckDbExecutor
from notebook_api.query.runner import WORKER_ENV_NAMES
from tests.evals.helpers import ENDLESS_SQL, write_shop_db, write_taxi_db

# Planning folds these constants, hashing twenty 100 MB strings one after
# another: work DuckDB's interrupt can't stop, because it isn't checked
# while planning.
CONSTANT_FOLDING = "SELECT " + " || ".join(
    f"md5(repeat('{chr(ord('a') + i)}', 100000000))" for i in range(20)
)


@pytest.fixture
def short_deadlines(monkeypatch: pytest.MonkeyPatch) -> float:
    """Shrink the allowances added to a query's timeout; returns the kill deadline's extra."""
    monkeypatch.setattr(sandbox, "STARTUP_ALLOWANCE_SECONDS", 1.0)
    monkeypatch.setattr(sandbox, "KILL_GRACE_SECONDS", 0.5)
    return 1.5


@pytest.fixture
def shop(tmp_path: Path) -> Path:
    return write_shop_db(tmp_path / "shop.sqlite")


@pytest.fixture
def pool() -> Iterator[SandboxPool]:
    processes = SandboxPool(max_idle=2)
    yield processes
    processes.close()


def _record_env_then_serve(record: Path) -> str:
    # Records the environment the child was started with (in a fresh
    # interpreter that's exactly the block passed to exec), then serves.
    return (
        "import json, os, sys\n"
        "from multiprocessing.connection import Connection\n"
        "from notebook_api.evals.sandbox import child_main\n"
        f"open({str(record)!r}, 'w').write(json.dumps(sorted(os.environ)))\n"
        "child_main(Connection(int(sys.argv[1])))\n"
    )


# Answers nothing: stands in for work an engine can't interrupt.
_NEVER_ANSWERS = (
    "import sys, time\n"
    "from multiprocessing.connection import Connection\n"
    "conn = Connection(int(sys.argv[1]))\n"
    "conn.recv_bytes(); conn.recv_bytes()\n"
    "time.sleep(60)\n"
)
# Dies as soon as a query arrives (a segfault or the OS killing it).
_CRASHES = (
    "import os, sys\n"
    "from multiprocessing.connection import Connection\n"
    "conn = Connection(int(sys.argv[1]))\n"
    "conn.recv_bytes(); conn.recv_bytes()\n"
    "os._exit(3)\n"
)


# Slow to start (it answers its first query after a second, as an interpreter
# that takes long to import would), then never answers its second.
_SLOW_START_THEN_HANGS = (
    "import json, sys, time\n"
    "from multiprocessing.connection import Connection\n"
    "conn = Connection(int(sys.argv[1]))\n"
    "conn.recv_bytes(); conn.recv_bytes()\n"
    "time.sleep(1.0)\n"
    'conn.send_bytes(json.dumps({"status": "ok", "rows": [[["i", "1"]]], "row_count": 1,'
    ' "error": None, "duration_ms": 1.0}).encode())\n'
    "conn.recv_bytes()\n"
    "time.sleep(60)\n"
)


def _script_command(script: str) -> object:
    return lambda fd: [sys.executable, "-I", "-c", script, str(fd)]


def test_a_kept_process_that_died_while_idle_is_replaced_not_blamed(
    pool: SandboxPool, shop: Path
) -> None:
    job = sqlite_job(shop, "SELECT 1", timeout_seconds=5, row_cap=10)
    assert pool.run(job, timeout_seconds=5).status == "ok"
    [dead] = pool._idle
    dead.process.kill()  # e.g. the OS killed it between queries
    dead.process.wait()
    outcome = pool.run(job, timeout_seconds=5)
    assert outcome.status == "ok" and outcome.rows == frozenset({(1,)})
    [fresh] = pool._idle
    assert fresh is not dead and fresh.process.poll() is None


def test_a_kept_process_whose_socket_is_gone_is_replaced(
    pool: SandboxPool, shop: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # It died after the liveness check: sending fails, so the query is sent
    # to a new process instead.
    job = sqlite_job(shop, "SELECT 2", timeout_seconds=5, row_cap=10)
    assert pool.run(job, timeout_seconds=5).status == "ok"
    [dead] = pool._idle
    dead.process.kill()
    dead.process.wait()
    monkeypatch.setattr(dead.process, "poll", lambda: None)  # the check didn't notice
    outcome = pool.run(job, timeout_seconds=5)
    assert outcome.rows == frozenset({(2,)})
    assert pool._idle[0] is not dead


def test_only_a_processs_first_query_gets_the_startup_allowance(
    pool: SandboxPool, shop: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sandbox, "STARTUP_ALLOWANCE_SECONDS", 3.0)
    monkeypatch.setattr(sandbox, "KILL_GRACE_SECONDS", 0.5)
    monkeypatch.setattr(sandbox, "child_command", _script_command(_SLOW_START_THEN_HANGS))
    job = sqlite_job(shop, "SELECT 1", timeout_seconds=0.1, row_cap=10)
    # The first query takes a second: past timeout + grace, within the
    # startup allowance, so it's answered.
    assert pool.run(job, timeout_seconds=0.1).status == "ok"
    # The second goes to the same, now started, process: its deadline is the
    # timeout plus the grace only.
    started = time.monotonic()
    outcome = pool.run(job, timeout_seconds=0.1)
    elapsed = time.monotonic() - started
    assert outcome.status == "timeout"
    assert 0.6 <= elapsed < 2.0  # well short of the 3 s startup allowance


def test_runs_a_query_and_reuses_the_process(pool: SandboxPool, shop: Path) -> None:
    outcome = pool.run(
        sqlite_job(shop, "SELECT 1", timeout_seconds=5, row_cap=10), timeout_seconds=5
    )
    assert outcome.status == "ok" and outcome.rows == frozenset({(1,)})
    [child] = pool._idle
    again = pool.run(sqlite_job(shop, "SELECT 2", timeout_seconds=5, row_cap=10), timeout_seconds=5)
    assert again.rows == frozenset({(2,)})
    assert pool._idle == [child]  # the same process answered both


def test_a_cooperative_timeout_keeps_the_process(pool: SandboxPool, shop: Path) -> None:
    outcome = pool.run(
        sqlite_job(shop, ENDLESS_SQL, timeout_seconds=0.2, row_cap=10), timeout_seconds=0.2
    )
    assert outcome.status == "timeout"
    assert "killed" not in (outcome.error or "")
    assert len(pool._idle) == 1


def test_a_process_that_never_answers_is_killed_at_the_deadline(
    pool: SandboxPool, shop: Path, short_deadlines: float, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sandbox, "child_command", _script_command(_NEVER_ANSWERS))
    started = time.monotonic()
    outcome = pool.run(
        sqlite_job(shop, "SELECT 1", timeout_seconds=0.1, row_cap=10), timeout_seconds=0.1
    )
    elapsed = time.monotonic() - started
    assert outcome.status == "timeout"
    assert outcome.error is not None and "killed" in outcome.error
    assert 0.1 + short_deadlines <= elapsed < 0.1 + short_deadlines + 2.0
    assert pool._idle == []  # never reused
    monkeypatch.undo()
    after = pool.run(sqlite_job(shop, "SELECT 3", timeout_seconds=5, row_cap=10), timeout_seconds=5)
    assert after.rows == frozenset({(3,)})  # a new process answers


def test_a_crashed_process_is_an_error_outcome(
    pool: SandboxPool, shop: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sandbox, "child_command", _script_command(_CRASHES))
    outcome = pool.run(
        sqlite_job(shop, "SELECT 1", timeout_seconds=5, row_cap=10), timeout_seconds=5
    )
    assert outcome.status == "error"
    assert outcome.error is not None and "query process failed" in outcome.error
    assert pool._idle == []


def test_children_start_with_a_clean_environment(
    pool: SandboxPool, shop: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "private-api-credential")
    monkeypatch.setenv("DATABASE_URL", "private-database-credential")
    record = tmp_path / "environment.json"
    monkeypatch.setattr(sandbox, "child_command", _script_command(_record_env_then_serve(record)))
    outcome = pool.run(
        sqlite_job(shop, "SELECT 1", timeout_seconds=5, row_cap=10), timeout_seconds=5
    )
    assert outcome.status == "ok"
    names = set(json.loads(record.read_text()))
    assert "ANTHROPIC_API_KEY" not in names and "DATABASE_URL" not in names
    # macOS itself sets __CF_USER_TEXT_ENCODING in every new process.
    added_by_os = {"__CF_USER_TEXT_ENCODING"} if sys.platform == "darwin" else set()
    assert names <= WORKER_ENV_NAMES | added_by_os


def test_close_stops_the_idle_processes(shop: Path) -> None:
    processes = SandboxPool()
    processes.run(sqlite_job(shop, "SELECT 1", timeout_seconds=5, row_cap=10), timeout_seconds=5)
    [child] = processes._idle
    processes.close()
    assert child.process.poll() is not None
    after = processes.run(
        sqlite_job(shop, "SELECT 1", timeout_seconds=5, row_cap=10), timeout_seconds=5
    )
    assert after.status == "error"  # closed: no new processes


def test_the_taxi_executor_kills_constant_folding_it_cannot_interrupt(
    tmp_path: Path, short_deadlines: float
) -> None:
    executor = DuckDbExecutor(
        write_taxi_db(tmp_path / "taxi.duckdb"), timeout_seconds=0.1, row_cap=10
    )
    try:
        assert executor.execute("SELECT 1").status == "ok"  # a warm process: no startup cost
        started = time.monotonic()
        outcome = executor.execute(CONSTANT_FOLDING)
        elapsed = time.monotonic() - started
        assert outcome.status == "timeout"
        assert outcome.error is not None and "killed" in outcome.error
        assert elapsed < 0.1 + short_deadlines + 2.0
        # A new process answers the next query.
        assert executor.execute("SELECT 42").rows == frozenset({(42,)})
    finally:
        executor.close()


@pytest.mark.skipif(sys.platform != "linux", reason="RLIMIT_DATA is only enforced on Linux")
def test_on_linux_a_process_past_its_memory_cap_fails_the_query(shop: Path) -> None:
    # One SQLite function call building a 500 MB string, in a process capped
    # at 256 MB: the allocation fails and the query is an error, not a hang
    # or a crash of the eval. (Runs in `pnpm test:api:linux`.)
    processes = SandboxPool(memory_cap_mb=256)
    try:
        sql = "SELECT length(printf('%.*c', 500000000, 'x'))"
        outcome = processes.run(
            sqlite_job(shop, sql, timeout_seconds=30, row_cap=10), timeout_seconds=30
        )
        assert outcome.status == "error"
    finally:
        processes.close()


def test_taxi_executor_errors_name_no_server_paths(tmp_path: Path) -> None:
    (tmp_path / "data").mkdir()
    db = write_taxi_db(tmp_path / "data" / "taxi.duckdb")
    executor = DuckDbExecutor(db, timeout_seconds=5, row_cap=10)
    try:
        outcome = executor.execute(f"SELECT * FROM read_text('{db}.other')")
        assert outcome.status == "error"
        assert outcome.error is not None and str(db) not in outcome.error
        assert "<server path>.other" in outcome.error
    finally:
        executor.close()
