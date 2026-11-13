"""Opening the locked-down DuckDB connection and running one query on it.

This code runs inside a worker process (see worker.py). It's kept free of
process plumbing so it can be tested directly.
"""

import json
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict

import duckdb

from notebook_api.query.serialize import JsonValue, to_json_value
from notebook_api.query.validate import PreparedQuery

_FETCH_BATCH_ROWS = 500


@dataclass(frozen=True)
class EngineLimits:
    """Per-worker resource limits. Defaults live in config.Settings."""

    memory_limit_mb: int  # DuckDB's buffer manager (not every allocation)
    process_memory_cap_mb: int  # OS cap on the whole worker (Linux only; see worker.py)
    threads: int
    max_spill_size_mb: int
    timeout_seconds: float
    row_limit: int
    max_result_bytes: int


class ResultColumn(TypedDict):
    name: str
    type: str  # DuckDB type name, e.g. "TIMESTAMP" or "DECIMAL(10,2)"


class QueryResult(TypedDict):
    """The JSON shape of a successful query, from the worker to the browser."""

    columns: list[ResultColumn]
    rows: list[list[JsonValue]]
    row_count: int
    truncated: bool  # true if the row limit or the size cap cut the result short
    duration_ms: float  # measured inside the worker


class QueryTimeoutError(Exception):
    pass


def open_connection(
    db_path: Path, spill_dir: Path, limits: EngineLimits
) -> duckdb.DuckDBPyConnection:
    """Open the taxi database with the lockdown layers listed below applied.

    - read_only: no writes to the database file, whatever the SQL says.
    - enable_external_access=false: no reading or writing other files or URLs
      (read_csv('/etc/passwd'), ATTACH, COPY, httpfs), no installing extensions.
    - autoload/autoinstall/community extensions off: nothing new gets loaded.
    - memory_limit, threads, max_temp_directory_size: bounded resources; big
      sorts and joins spill to `spill_dir` up to the size cap, then fail.
    - lock_configuration=true: user SQL can't SET any of the above back.
    """
    config: dict[str, str | bool | int | float | list[str]] = {
        "enable_external_access": False,
        "autoload_known_extensions": False,
        "autoinstall_known_extensions": False,
        "allow_community_extensions": False,
        "memory_limit": f"{limits.memory_limit_mb}MB",
        "threads": limits.threads,
        "temp_directory": str(spill_dir),
        "max_temp_directory_size": f"{limits.max_spill_size_mb}MB",
    }
    con = duckdb.connect(str(db_path), read_only=True, config=config)
    # TimeZone comes from the ICU extension and can't be passed to connect().
    # It's set GLOBAL so every per-query cursor inherits it, before the
    # configuration is locked. Results then don't depend on the host's zone.
    con.execute("SET GLOBAL TimeZone = 'UTC'")
    con.execute("SET lock_configuration = true")
    return con


def execute(
    con: duckdb.DuckDBPyConnection, query: PreparedQuery, limits: EngineLimits
) -> QueryResult:
    """Run `query` on a fresh cursor and return a JSON-safe result.

    Each query gets its own cursor, which is closed afterwards. Session state
    a query could create (temp tables and views, macros, variables, prepared
    statements) lives on that cursor and disappears with it, so one query can
    never change what a later query sees. The database file itself is
    read-only, and settings are locked.

    The timeout is cooperative: a timer calls DuckDB's interrupt(), which
    stops the query at its next check. The parent process also kills the
    worker if it doesn't answer shortly after the timeout, in case DuckDB is
    stuck somewhere interrupt can't reach.

    Raises QueryTimeoutError on timeout and duckdb.Error for query errors.
    """
    started = time.perf_counter()
    cursor = con.cursor()
    timer = threading.Timer(limits.timeout_seconds, cursor.interrupt)
    timer.start()
    try:
        cursor.execute(query.sql)
        description = cursor.description or []
        columns: list[ResultColumn] = [{"name": d[0], "type": str(d[1])} for d in description]
        rows: list[list[JsonValue]] = []
        truncated = False
        size = 0
        while not truncated and (batch := cursor.fetchmany(_FETCH_BATCH_ROWS)):
            for raw in batch:
                if len(rows) >= limits.row_limit:
                    truncated = True
                    break
                row = [to_json_value(v) for v in raw]
                size += len(json.dumps(row))
                if size > limits.max_result_bytes:
                    truncated = True
                    break
                rows.append(row)
    except duckdb.InterruptException:
        raise QueryTimeoutError(
            f"The query took longer than {limits.timeout_seconds:g} seconds and was stopped."
        ) from None
    finally:
        timer.cancel()
        cursor.close()

    return {
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "truncated": truncated,
        "duration_ms": round((time.perf_counter() - started) * 1000, 3),
    }
