"""Running the eval's SQL in separate processes that can be killed.

The eval executes model-written SQL (and the gold SQL it is compared with)
on the taxi database (DuckDB) and on BIRD's SQLite files. Both engines stop
a query cooperatively: DuckDB's interrupt, SQLite's progress handler. Neither
can stop work during which they never check: DuckDB evaluates constant
expressions while planning (`SELECT length(repeat('x', 300000000))`), and
one SQLite function call can build a huge value. Run in the eval's own
process, such a query could hang the whole run or exhaust its memory.

So queries run in child processes, started like the API's query workers:
`python -I -m notebook_api.evals.sandbox <fd>`, with the same allowlisted
environment (so the Anthropic API key the eval holds never reaches the
process running model-written SQL) and only their socket passed in. On
Linux each child's writable memory is capped with RLIMIT_DATA. A child that
hasn't answered by the query timeout plus the kill grace (plus a startup
allowance on its first query) is killed, and the query counts as timed out.
A kept child found dead when the next query arrives is replaced, and the
query goes to the new one.

A child that answered (including a cooperative timeout) is kept for the
next query, so the eval doesn't start an interpreter per query; every query
still opens its own connection, so no database state carries over. A child
that was killed, crashed or sent a bad reply is never reused.

Messages are JSON over multiprocessing's Connection framing, never pickle.
Parent -> child: {"memory_cap_mb"} once, first; then per query
                 {"engine": "duckdb" | "sqlite", "db_path", "sql",
                  "timeout_seconds", "row_cap",
                  "spill_dir", "memory_limit_mb" (duckdb only)}
Child -> parent: {"status", "rows" (rowcodec-encoded, or null), "row_count",
                  "error", "duration_ms"} per query
"""

import json
import logging
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Hashable
from dataclasses import dataclass
from multiprocessing import Pipe
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any, get_args

from notebook_api.evals.execution import ExecOutcome, ExecStatus, short_error
from notebook_api.evals.rowcodec import decode_rows, encode_rows
from notebook_api.query.runner import KILL_GRACE_SECONDS, worker_environment

logger = logging.getLogger(__name__)

MODULE = "notebook_api.evals.sandbox"
# Added to the deadline of a process's first query only: starting the
# interpreter and importing the engine happen then. A generous allowance,
# not a measured one.
STARTUP_ALLOWANCE_SECONDS = 15.0
# A backstop against runaway allocations, not a tuned limit: far above what
# DuckDB's own memory limit lets a query use, with room for converting up to
# the row cap of results to Python values. Enforced on Linux only.
MEMORY_CAP_MB = 4096
# Results are capped by row count, not size; this only stops a reply so
# large that reading it would itself exhaust memory.
_MAX_REPLY_BYTES = 1024 * 1024 * 1024
_MAX_MESSAGE_BYTES = 1_000_000
_FETCH_BATCH_ROWS = 1_000
_STATUSES = frozenset(get_args(ExecStatus))


def child_command(fd: int) -> list[str]:
    """The command that starts one child, talking over socket `fd`."""
    return [sys.executable, "-I", "-m", MODULE, str(fd)]


@dataclass(eq=False)
class _Child:
    process: subprocess.Popen[bytes]
    conn: Connection

    def kill(self) -> None:
        self.process.kill()  # a no-op if it already exited
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            logger.error("eval query process did not exit after SIGKILL (pid %s)", self.process.pid)
        self.conn.close()


class SandboxPool:
    """Child processes that run one query each at a time; thread-safe.

    `run` blocks (async callers use asyncio.to_thread). Up to `max_idle`
    children are kept between queries; more are started when several
    queries run at once, and the extra ones are stopped when they finish.
    """

    def __init__(self, *, max_idle: int = 4, memory_cap_mb: int = MEMORY_CAP_MB) -> None:
        self._max_idle = max_idle
        self._memory_cap_mb = memory_cap_mb
        self._idle: list[_Child] = []
        self._lock = threading.Lock()
        self._closed = False

    def run(self, job: dict[str, Any], *, timeout_seconds: float) -> ExecOutcome:
        """Run one query and return its outcome.

        Never raises for anything the query does: a timeout, a crash or an
        unreadable reply each come back as an outcome.
        """
        started = time.perf_counter()

        def elapsed() -> float:
            return round((time.perf_counter() - started) * 1000, 3)

        child: _Child | None = None
        healthy = False
        payload = json.dumps(job).encode("utf-8")
        try:
            child = self._take()
            fresh = False
            if child is not None and not self._send_to_idle(child, payload):
                # It died while idle (the OS killed it, say). That says
                # nothing about this query, so it goes to a new process
                # rather than counting as the query's error.
                child.kill()
                child = None
            if child is None:
                child = self._start()
                fresh = True
                child.conn.send_bytes(payload)
            # Starting the interpreter and importing the engine only happen
            # before a process's first query, so only that one gets the
            # startup allowance.
            deadline = timeout_seconds + KILL_GRACE_SECONDS
            if fresh:
                deadline += STARTUP_ALLOWANCE_SECONDS
            if not child.conn.poll(deadline):
                return ExecOutcome(
                    "timeout",
                    error=f"stopped after {timeout_seconds:g} seconds (the query process was "
                    "killed)",
                    duration_ms=elapsed(),
                )
            raw = child.conn.recv_bytes(_MAX_REPLY_BYTES)
            outcome = _decode_outcome(json.loads(raw))
            healthy = True
            return outcome
        except (EOFError, OSError) as error:
            # The child died (a crash, or the OS memory cap), couldn't start,
            # or sent more than a reply may be.
            return ExecOutcome(
                "error",
                error=f"the query process failed: {short_error(error)}",
                duration_ms=elapsed(),
            )
        except (ValueError, TypeError, KeyError) as error:
            return ExecOutcome(
                "error",
                error=f"the query process sent an unexpected reply: {short_error(error)}",
                duration_ms=elapsed(),
            )
        finally:
            if child is not None:
                self._give_back(child, healthy)

    def close(self) -> None:
        """Stop the idle children; busy ones are stopped when their query ends."""
        with self._lock:
            self._closed = True
            idle, self._idle = self._idle, []
        for child in idle:
            child.kill()

    @staticmethod
    def _send_to_idle(child: _Child, payload: bytes) -> bool:
        """Send a query to a kept child; False if it has died since its last reply."""
        if child.process.poll() is not None:
            return False
        try:
            child.conn.send_bytes(payload)
        except OSError:  # it died after the check: the socket's other end is gone
            return False
        return True

    def _take(self) -> _Child | None:
        with self._lock:
            if self._closed:
                raise OSError("the eval's query processes were shut down")
            return self._idle.pop() if self._idle else None

    def _start(self) -> _Child:
        parent, child_end = Pipe()
        try:
            process = subprocess.Popen(  # noqa: S603 (a fixed command, no shell, no user input)
                child_command(child_end.fileno()),
                env=worker_environment(),
                pass_fds=(child_end.fileno(),),
                stdin=subprocess.DEVNULL,
            )
        except BaseException:
            parent.close()
            raise
        finally:
            child_end.close()
        child = _Child(process, parent)
        try:
            parent.send_bytes(json.dumps({"memory_cap_mb": self._memory_cap_mb}).encode())
        except BaseException:
            child.kill()
            raise
        return child

    def _give_back(self, child: _Child, healthy: bool) -> None:
        # A child that didn't give a clean reply is in an unknown state (it
        # may still be running the query, or answer late): never reused.
        if healthy:
            with self._lock:
                if not self._closed and len(self._idle) < self._max_idle:
                    self._idle.append(child)
                    return
        child.kill()


def duckdb_job(
    db_path: Path,
    sql: str,
    *,
    spill_dir: Path,
    timeout_seconds: float,
    row_cap: int,
    memory_limit_mb: int,
) -> dict[str, Any]:
    return {
        "engine": "duckdb",
        "db_path": str(db_path),
        "spill_dir": str(spill_dir),
        "sql": sql,
        "timeout_seconds": timeout_seconds,
        "row_cap": row_cap,
        "memory_limit_mb": memory_limit_mb,
    }


def sqlite_job(db_path: Path, sql: str, *, timeout_seconds: float, row_cap: int) -> dict[str, Any]:
    return {
        "engine": "sqlite",
        "db_path": str(db_path),
        "sql": sql,
        "timeout_seconds": timeout_seconds,
        "row_cap": row_cap,
    }


def _encode_outcome(outcome: ExecOutcome) -> dict[str, Any]:
    return {
        "status": outcome.status,
        "rows": encode_rows(outcome.rows) if outcome.rows is not None else None,
        "row_count": outcome.row_count,
        "error": outcome.error,
        "duration_ms": outcome.duration_ms,
    }


def _decode_outcome(data: dict[str, Any]) -> ExecOutcome:
    status = data["status"]
    if status not in _STATUSES:
        raise ValueError(f"unknown status {status!r}")
    rows = data["rows"]
    error = data["error"]
    return ExecOutcome(
        status,
        rows=decode_rows(rows) if rows is not None else None,
        row_count=int(data["row_count"]),
        error=str(error) if error is not None else None,
        duration_ms=float(data["duration_ms"]),
    )


class SpillRoot:
    """A private temporary directory for the DuckDB queries' spill files.

    Each query gets its own subdirectory, deleted when it ends, so a killed
    process can't leave files that the next query trips on.
    """

    def __init__(self) -> None:
        self.path = Path(tempfile.mkdtemp(prefix="eval-duckdb-spill-"))

    def query_dir(self) -> Path:
        return Path(tempfile.mkdtemp(dir=self.path))

    def close(self) -> None:
        shutil.rmtree(self.path, ignore_errors=True)


# --- the child process -------------------------------------------------------------


def hashable(value: object) -> Hashable:
    # DuckDB returns lists for LIST columns and dicts for STRUCT/MAP ones;
    # sets need hashable rows.
    if isinstance(value, (list, tuple)):
        return tuple(hashable(item) for item in value)
    if isinstance(value, dict):
        return tuple(sorted((str(key), hashable(item)) for key, item in value.items()))
    return value


def run_duckdb(job: dict[str, Any]) -> ExecOutcome:
    """Run one query on the taxi database with the notebook's lockdown and checks.

    The same lockdown as the query engine (read-only file, no external
    access, settings locked, see query/engine.py) and the same SQL checks
    (`prepare_query`), on a connection opened for this query alone. Server
    paths are removed from errors as the query workers do.
    """
    import duckdb

    from notebook_api.query.engine import EngineLimits, open_connection
    from notebook_api.query.paths import PathScrubber, private_paths
    from notebook_api.query.validate import QueryRejectedError, prepare_query

    started = time.perf_counter()

    def elapsed() -> float:
        return round((time.perf_counter() - started) * 1000, 3)

    db_path, spill_dir = Path(job["db_path"]), Path(job["spill_dir"])
    timeout_seconds, row_cap = float(job["timeout_seconds"]), int(job["row_cap"])
    scrubber = PathScrubber([*private_paths(db_path, spill_dir.parent), spill_dir])
    try:
        prepared = prepare_query(job["sql"], row_cap)
    except QueryRejectedError as error:
        return ExecOutcome("error", error=short_error(error), duration_ms=elapsed())
    limits = EngineLimits(
        memory_limit_mb=int(job["memory_limit_mb"]),
        process_memory_cap_mb=MEMORY_CAP_MB,
        threads=2,
        max_spill_size_mb=2048,
        timeout_seconds=timeout_seconds,
        row_limit=row_cap,
        max_result_bytes=0,  # unused here: rows are compared, not sent to a browser
    )
    try:
        con = open_connection(db_path, spill_dir, limits)
    except duckdb.Error as error:
        return ExecOutcome("error", error=scrubber.text(short_error(error)), duration_ms=elapsed())
    cursor = con.cursor()
    timer = threading.Timer(timeout_seconds, cursor.interrupt)
    timer.start()
    rows: set[tuple[Hashable, ...]] = set()
    count = 0
    try:
        cursor.execute(prepared.sql)
        while batch := cursor.fetchmany(_FETCH_BATCH_ROWS):
            count += len(batch)
            if count > row_cap:
                return ExecOutcome(
                    "too_many_rows",
                    row_count=count,
                    error=f"more than {row_cap} rows",
                    duration_ms=elapsed(),
                )
            rows.update(tuple(hashable(value) for value in row) for row in batch)
    except duckdb.InterruptException:
        return ExecOutcome(
            "timeout", error=f"stopped after {timeout_seconds:g} seconds", duration_ms=elapsed()
        )
    except (duckdb.Error, MemoryError) as error:
        return ExecOutcome("error", error=scrubber.text(short_error(error)), duration_ms=elapsed())
    finally:
        timer.cancel()
        cursor.close()
        con.close()
    return ExecOutcome("ok", rows=frozenset(rows), row_count=count, duration_ms=elapsed())


def run_sqlite(job: dict[str, Any]) -> ExecOutcome:
    from notebook_api.evals.sqlite_db import execute_query

    return execute_query(
        Path(job["db_path"]),
        job["sql"],
        timeout_seconds=float(job["timeout_seconds"]),
        row_cap=int(job["row_cap"]),
    )


def child_main(conn: Connection) -> None:
    from notebook_api.query.worker import cap_process_memory

    # Ctrl-C in the terminal goes to the whole process group. The parent owns
    # shutdown (it closes the pipe), so children don't die mid-reply.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        config = json.loads(conn.recv_bytes(_MAX_MESSAGE_BYTES))
    except EOFError, OSError:  # the parent gave up before configuring us
        return
    cap_process_memory(int(config["memory_cap_mb"]))
    while True:
        try:
            job = json.loads(conn.recv_bytes(_MAX_MESSAGE_BYTES))
        except EOFError:  # the parent closed the pipe (or exited): shut down
            return
        engine = job.get("engine")
        if engine == "duckdb":
            outcome = run_duckdb(job)
        elif engine == "sqlite":
            outcome = run_sqlite(job)
        else:
            outcome = ExecOutcome("error", error=f"unknown engine {engine!r}")
        conn.send_bytes(json.dumps(_encode_outcome(outcome)).encode("utf-8"))


if __name__ == "__main__":
    child_main(Connection(int(sys.argv[1])))
