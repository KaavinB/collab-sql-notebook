"""The query worker process: one locked-down DuckDB connection, one query at a time.

runner.py starts it as `python -I -m notebook_api.query.worker <fd>` with a
minimal environment (see runner.worker_environment), so database passwords
and API keys never reach the process that runs untrusted SQL: not in
os.environ, and not in the process's initial environment block either
(/proc/<pid>/environ on Linux). `<fd>` is the worker's end of a socket pair.

Messages travel over that socket as length-prefixed JSON (multiprocessing's
Connection framing), never pickle. The worker runs untrusted SQL, so the
parent treats whatever comes back as data: unpickling would let a
compromised worker run code in the API process.

Parent -> worker:  {"db_path": str, "spill_dir": str, "limits": {...}} once, first
                   {"id": str, "sql": str, "mode": "run" | "explain"}  ("mode" defaults to "run")
Worker -> parent:  {"ready": true} once, after opening DuckDB (or {"ready": false, "message": str})
                   {"id": str, "ok": true, "result": {...}}   (run)
                   {"id": str, "ok": true, "result": null}    (explain: it planned)
                   {"id": str, "ok": false, "kind": "timeout" | "error", "message": str}
"""

import json
import resource
import signal
import sys
from multiprocessing.connection import Connection
from pathlib import Path

import duckdb

from notebook_api.query.engine import (
    EngineLimits,
    QueryResult,
    QueryTimeoutError,
    execute,
    explain,
    open_connection,
)
from notebook_api.query.paths import PathScrubber, private_paths
from notebook_api.query.validate import PreparedQuery

_OUT_OF_MEMORY = "The query needed more memory than a worker is allowed."
# "run" executes and returns rows; "explain" only plans (AI answer validation).
_MODES = frozenset({"run", "explain"})
# The config message is a few hundred bytes; refuse anything absurd.
_MAX_CONFIG_BYTES = 64_000


def _send(conn: Connection, message: dict[str, object]) -> None:
    conn.send_bytes(json.dumps(message).encode("utf-8"))


def cap_process_memory(cap_mb: int) -> bool:
    """Cap this process's writable memory with RLIMIT_DATA. Linux only.

    DuckDB's memory_limit governs its buffer manager, but some allocations
    (one huge string or list value, converting rows to Python) fall outside
    it. RLIMIT_DATA bounds all of them: past the cap, allocations fail and
    DuckDB raises a normal out-of-memory error. (RLIMIT_AS can't be used:
    DuckDB reserves a lot of address space up front and crashes under it.)
    macOS doesn't enforce RLIMIT_DATA, so on a dev Mac the parent's
    kill-on-timeout is the only backstop. Returns whether the cap was applied.
    """
    if not sys.platform.startswith("linux"):
        return False
    limit = cap_mb * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_DATA, (limit, limit))
    return True


def scrubbed_result(result: QueryResult, scrubber: PathScrubber) -> QueryResult:
    """The result with server paths removed from column names and values.

    A backstop behind the validator's list of functions that return paths:
    if some other DuckDB function hands one back verbatim, it still doesn't
    reach the notebook.
    """
    return {
        **result,
        "columns": [
            {"name": scrubber.text(column["name"]), "type": column["type"]}
            for column in result["columns"]
        ],
        "rows": [[scrubber.value(value) for value in row] for row in result["rows"]],
    }


def worker_main(conn: Connection) -> None:
    # Ctrl-C in the terminal goes to the whole process group. The parent owns
    # shutdown, so workers ignore SIGINT instead of dying mid-reply.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        config = json.loads(conn.recv_bytes(_MAX_CONFIG_BYTES))
    except EOFError, OSError:  # the parent gave up before configuring us
        return
    try:
        limits = EngineLimits(**config["limits"])
        cap_process_memory(limits.process_memory_cap_mb)
        db_path, spill_dir = Path(config["db_path"]), Path(config["spill_dir"])
        # Every worker's spill directory sits directly in the spill root.
        scrubber = PathScrubber([*private_paths(db_path, spill_dir.parent), spill_dir])
        con = open_connection(db_path, spill_dir, limits)
    except Exception as error:  # report any startup failure to the parent
        _send(conn, {"ready": False, "message": str(error)})
        return
    _send(conn, {"ready": True})

    while True:
        try:
            request = json.loads(conn.recv_bytes())
        except EOFError:  # parent closed the pipe (or exited): shut down
            return
        request_id = request["id"]
        mode = request.get("mode", "run")
        if mode not in _MODES:
            _send(conn, {"id": request_id, "ok": False, "kind": "error", "message": "Bad request."})
            continue
        try:
            query = PreparedQuery(sql=request["sql"])
            if mode == "explain":
                explain(con, query, limits)
                result = None
            else:
                result = scrubbed_result(execute(con, query, limits), scrubber)
        except QueryTimeoutError as error:
            _send(conn, {"id": request_id, "ok": False, "kind": "timeout", "message": str(error)})
        except duckdb.OutOfMemoryException:
            _send(conn, {"id": request_id, "ok": False, "kind": "error", "message": _OUT_OF_MEMORY})
        except MemoryError:  # hit the process cap while building the result
            _send(conn, {"id": request_id, "ok": False, "kind": "error", "message": _OUT_OF_MEMORY})
        except duckdb.Error as error:
            # DuckDB's messages can name the database file or a spill file.
            message = scrubber.text(str(error))
            _send(conn, {"id": request_id, "ok": False, "kind": "error", "message": message})
        else:
            _send(conn, {"id": request_id, "ok": True, "result": result})


def main() -> None:
    worker_main(Connection(int(sys.argv[1])))


if __name__ == "__main__":
    main()
