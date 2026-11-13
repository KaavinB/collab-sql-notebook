"""A pool of query worker processes (D3, D16).

Why processes: a query that ignores DuckDB's interrupt, or blows past the
memory limit, can be killed outright without touching the API process. A
killed worker is replaced by a fresh one and its spill directory is deleted.

Each worker handles one query at a time. Idle workers wait in an asyncio
queue; a request that can't get a worker within `queue_timeout_seconds` is
refused as busy instead of piling up.

Nothing slow runs on the event loop: SQL parsing, process start, kill and
cleanup run in threads. Waiting for and reading a reply is one blocking
`poll` + `recv_bytes` on a dedicated thread pool. (Not the loop's add_reader:
uvloop, which uvicorn uses, makes the pipe non-blocking when a reader is
attached, so a reply larger than the pipe buffer then fails to read.)
"""

import asyncio
import json
import logging
import multiprocessing
import secrets
import shutil
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from multiprocessing.connection import Connection
from multiprocessing.process import BaseProcess
from pathlib import Path
from typing import Any, Literal, cast

from notebook_api.query.engine import EngineLimits, QueryResult
from notebook_api.query.validate import prepare_query
from notebook_api.query.worker import worker_main

logger = logging.getLogger(__name__)

# How long past the query timeout the parent waits for an answer before it
# kills the worker. Covers the interrupt taking effect plus sending the reply.
_KILL_GRACE_SECONDS = 2.0
_WORKER_START_TIMEOUT_SECONDS = 30.0
_RESPAWN_BACKOFF_MAX_SECONDS = 10.0
_SPILL_DIR_PREFIX = "worker-"
# Room for column metadata and JSON framing on top of the rows' size cap.
_REPLY_OVERHEAD_BYTES = 1_000_000

FailureKind = Literal["timeout", "error", "busy", "crashed"]


class QueryFailedError(Exception):
    """The query was valid but didn't produce a result. The message is safe to show users."""

    def __init__(self, kind: FailureKind, message: str) -> None:
        super().__init__(message)
        self.kind = kind


class WorkerStartError(Exception):
    pass


# eq=False keeps identity hashing, so workers can live in a set.
@dataclass(eq=False)
class _Worker:
    process: BaseProcess
    conn: Connection
    spill_dir: Path


class QueryRunner:
    def __init__(
        self,
        db_path: Path,
        spill_root: Path,
        limits: EngineLimits,
        workers: int,
        queue_timeout_seconds: float,
    ) -> None:
        if workers < 1:
            raise ValueError("workers must be at least 1")
        self._db_path = db_path
        self._spill_root = spill_root
        self._limits = limits
        self._size = workers
        self._queue_timeout = queue_timeout_seconds
        self._max_reply_bytes = limits.max_result_bytes + _REPLY_OVERHEAD_BYTES
        # spawn, not fork: forking a process that has threads (DuckDB, uvicorn)
        # can copy locks in a held state and deadlock the child.
        self._ctx = multiprocessing.get_context("spawn")
        self._idle: asyncio.Queue[_Worker] = asyncio.Queue()
        self._all: set[_Worker] = set()
        # Retired workers until they're confirmed dead (close() kills these too).
        self._dying: set[_Worker] = set()
        self._background: set[asyncio.Task[None]] = set()
        # One reader thread per worker, plus room for replacements starting up
        # while a retired worker's read is still finishing. A read ends when its
        # reply arrives or its worker is killed (EOF), so threads don't pile up.
        self._readers = ThreadPoolExecutor(
            max_workers=2 * workers + 2, thread_name_prefix="query-pipe"
        )
        self._closed = False

    async def start(self) -> None:
        if not self._db_path.is_file():
            raise FileNotFoundError(f"DuckDB database not found: {self._db_path} (run pnpm ingest)")
        self._spill_root.mkdir(parents=True, exist_ok=True)
        # Spill directories left by a previous run that was killed.
        for stale in self._spill_root.glob(_SPILL_DIR_PREFIX + "*"):
            await asyncio.to_thread(shutil.rmtree, stale, True)
        results = await asyncio.gather(
            *(self._spawn() for _ in range(self._size)), return_exceptions=True
        )
        workers = [r for r in results if isinstance(r, _Worker)]
        failures = [r for r in results if isinstance(r, BaseException)]
        if failures:
            # Don't leave the workers that did start running in the background.
            await asyncio.gather(*(asyncio.to_thread(self._kill, w) for w in workers))
            raise failures[0]
        for worker in workers:
            self._all.add(worker)
            self._idle.put_nowait(worker)

    async def close(self) -> None:
        self._closed = True
        for task in list(self._background):
            task.cancel()
        everyone = list(self._all | self._dying)
        await asyncio.gather(*(asyncio.to_thread(self._kill, w) for w in everyone))
        self._all.clear()
        self._dying.clear()
        self._readers.shutdown(wait=False, cancel_futures=True)

    async def run(self, sql: str) -> QueryResult:
        """Validate and run `sql`, returning the JSON-safe result.

        Raises QueryRejectedError (invalid SQL) or QueryFailedError.
        """
        # Parsing is CPU-bound; keep it off the event loop.
        prepared = await asyncio.to_thread(prepare_query, sql, self._limits.row_limit)
        try:
            worker = await asyncio.wait_for(self._idle.get(), self._queue_timeout)
        except TimeoutError:
            raise QueryFailedError(
                "busy", "All query workers are busy. Try again in a moment."
            ) from None

        request_id = secrets.token_hex(8)
        healthy = False
        try:
            worker.conn.send_bytes(json.dumps({"id": request_id, "sql": prepared.sql}).encode())
            reply = await self._wait_for_reply(worker, request_id)
            healthy = True
        finally:
            # A clean, matching reply means the worker is idle again, including
            # after a cooperative timeout (DuckDB's interrupt worked and the
            # worker said so). Anything else (the parent's deadline passed, a
            # crash, a bad reply, or this request being cancelled mid-query)
            # leaves the worker in an unknown state: a late reply could be read
            # by the next request. That worker is killed and replaced.
            if healthy:
                self._idle.put_nowait(worker)
            else:
                self._retire(worker)

        if reply["ok"]:
            # Built by engine.execute in our own worker code, so its shape is known.
            return cast(QueryResult, reply["result"])
        raise QueryFailedError(reply["kind"], reply["message"])

    async def _wait_for_reply(self, worker: _Worker, request_id: str) -> dict[str, Any]:
        deadline = self._limits.timeout_seconds + _KILL_GRACE_SECONDS
        try:
            raw = await self._receive(worker.conn, deadline, self._max_reply_bytes)
        except EOFError, OSError:
            logger.exception("query worker pipe failed (pid %s)", worker.process.pid)
            raise QueryFailedError(
                "crashed", "The query engine stopped unexpectedly. Try again."
            ) from None
        if raw is None:
            raise QueryFailedError(
                "timeout",
                f"The query took longer than {self._limits.timeout_seconds:g} seconds "
                "and was stopped.",
            )
        try:
            reply: dict[str, Any] = json.loads(raw)
        except ValueError:
            logger.exception("query worker sent invalid JSON (pid %s)", worker.process.pid)
            raise QueryFailedError(
                "crashed", "The query engine returned an unexpected reply."
            ) from None
        if reply.get("id") != request_id:
            logger.error("query worker reply id mismatch (pid %s)", worker.process.pid)
            raise QueryFailedError("crashed", "The query engine returned an unexpected reply.")
        return reply

    async def _receive(self, conn: Connection, wait_seconds: float, maxlength: int) -> bytes | None:
        """Wait up to `wait_seconds` for one message and read it, on a reader thread.

        Returns None on timeout. maxlength stops an oversized reply from a
        misbehaving worker. If this request is cancelled, the thread keeps
        waiting until the worker is killed (in _retire), which ends it with EOF.
        """
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._readers, _poll_and_read, conn, wait_seconds, maxlength
        )

    async def _spawn(self) -> _Worker:
        spill_dir = self._spill_root / f"{_SPILL_DIR_PREFIX}{secrets.token_hex(4)}"
        spill_dir.mkdir()
        parent_conn, child_conn = self._ctx.Pipe()
        process = self._ctx.Process(
            target=worker_main,
            args=(child_conn, str(self._db_path), str(spill_dir), self._limits),
            daemon=True,
        )
        worker = _Worker(process=process, conn=parent_conn, spill_dir=spill_dir)
        try:
            await asyncio.to_thread(process.start)
            child_conn.close()  # the parent keeps only its own end
            raw = await self._receive(parent_conn, _WORKER_START_TIMEOUT_SECONDS, 64_000)
            if raw is None:
                raise WorkerStartError("query worker did not start in time")
            hello = json.loads(raw)
            if not hello.get("ready"):
                raise WorkerStartError(f"query worker failed to start: {hello.get('message')}")
        except BaseException:
            await asyncio.to_thread(self._kill, worker)
            raise
        return worker

    def _kill(self, worker: _Worker) -> None:
        """Blocking: run it in a thread."""
        if worker.process.is_alive():
            worker.process.kill()
        worker.process.join(timeout=5)
        worker.conn.close()
        shutil.rmtree(worker.spill_dir, ignore_errors=True)

    def _retire(self, worker: _Worker) -> None:
        self._all.discard(worker)
        self._dying.add(worker)
        task = asyncio.get_running_loop().create_task(self._kill_and_replace(worker))
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def _kill_and_replace(self, worker: _Worker) -> None:
        await asyncio.to_thread(self._kill, worker)
        self._dying.discard(worker)
        delay = 0.5
        while not self._closed:
            try:
                replacement = await self._spawn()
            except asyncio.CancelledError:
                raise
            except Exception:
                # Keep trying: a pool that silently shrinks would end up
                # refusing every query as busy.
                logger.exception("could not start a replacement query worker; retrying")
                await asyncio.sleep(delay)
                delay = min(delay * 2, _RESPAWN_BACKOFF_MAX_SECONDS)
                continue
            if self._closed:
                await asyncio.to_thread(self._kill, replacement)
                return
            self._all.add(replacement)
            self._idle.put_nowait(replacement)
            return


def _poll_and_read(conn: Connection, wait_seconds: float, maxlength: int) -> bytes | None:
    """Blocking: wait for a message, then read all of it. Runs on a reader thread."""
    if not conn.poll(wait_seconds):
        return None
    return conn.recv_bytes(maxlength)
