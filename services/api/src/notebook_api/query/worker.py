"""The query worker process: one locked-down DuckDB connection, one query at a time.

Messages travel over a multiprocessing Pipe as JSON bytes, not pickle. The
worker runs untrusted SQL, so the parent treats whatever comes back as data:
unpickling would let a compromised worker run code in the API process.

Parent -> worker:  {"id": str, "sql": str}
Worker -> parent:  {"ready": true} once, at startup (or {"ready": false, "message": str})
                   {"id": str, "ok": true, "result": {...}}
                   {"id": str, "ok": false, "kind": "timeout" | "error", "message": str}
"""

import json
import os
import resource
import signal
import sys
from multiprocessing.connection import Connection
from pathlib import Path

import duckdb

from notebook_api.query.engine import EngineLimits, QueryTimeoutError, execute, open_connection
from notebook_api.query.validate import PreparedQuery

_OUT_OF_MEMORY = "The query needed more memory than a worker is allowed."

# Workers need locale and temporary-directory settings, not database passwords
# or API keys. Clear inherited application credentials before opening DuckDB.
# This reduces exposure inside the worker; it isn't an OS security boundary.
_WORKER_ENV = frozenset({"PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TMP", "TEMP"})


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


def worker_main(conn: Connection, db_path: str, spill_dir: str, limits: EngineLimits) -> None:
    for name in list(os.environ):
        if name not in _WORKER_ENV:
            del os.environ[name]
    # Ctrl-C in the terminal goes to the whole process group. The parent owns
    # shutdown, so workers ignore SIGINT instead of dying mid-reply.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        cap_process_memory(limits.process_memory_cap_mb)
        con = open_connection(Path(db_path), Path(spill_dir), limits)
    except Exception as error:  # report any startup failure to the parent
        _send(conn, {"ready": False, "message": str(error)})
        return
    _send(conn, {"ready": True})

    while True:
        try:
            request = json.loads(conn.recv_bytes())
        except EOFError:  # parent closed the pipe: shut down
            return
        request_id = request["id"]
        try:
            result = execute(con, PreparedQuery(sql=request["sql"]), limits)
        except QueryTimeoutError as error:
            _send(conn, {"id": request_id, "ok": False, "kind": "timeout", "message": str(error)})
        except duckdb.OutOfMemoryException:
            _send(conn, {"id": request_id, "ok": False, "kind": "error", "message": _OUT_OF_MEMORY})
        except MemoryError:  # hit the process cap while building the result
            _send(conn, {"id": request_id, "ok": False, "kind": "error", "message": _OUT_OF_MEMORY})
        except duckdb.Error as error:
            _send(conn, {"id": request_id, "ok": False, "kind": "error", "message": str(error)})
        else:
            _send(conn, {"id": request_id, "ok": True, "result": result})
