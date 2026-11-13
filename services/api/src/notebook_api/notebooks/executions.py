"""The per-cell execution lock: two Run presses on one cell become one execution.

A cell's lock is a row in `cell_executions`. Pressing Run:

1. Claims the lock in a short transaction: INSERT the row, or take over a
   row whose `expires_at` has passed (left behind by a crashed API process).
   The same transaction sends NOTIFY `run_started`, so the sync server can
   show everyone that the cell is running and who started it.
2. The claimer (the "winner") runs the query with no database transaction
   open, then in one transaction stores the run, deletes its lock row and
   sends NOTIFY `run_finished` with the run's ID. If the query service
   itself failed (busy, crashed), nothing is stored: the lock row is deleted
   and `run_finished` carries no run ID.
3. Anyone who presses Run while the lock is held (a "joiner") runs no SQL.
   They wait for that execution and get the same stored run back. Within one
   API process they wait on the execution's task directly; across processes
   they poll Postgres, so this works with any number of API instances.

The execution runs in its own asyncio task, not in the request that started
it. If the person who pressed Run closes the page (the request is
cancelled), the execution still finishes, stores its run and releases the
lock: others may be waiting for it, and everyone should see the result.
Whatever happens, including cancellation of the task itself at shutdown,
the lock is released in a `finally`, shielded so the release itself can't
be cut short.
"""

import asyncio
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from datetime import timedelta
from functools import partial
from typing import Any, Literal, Protocol

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from notebook_api import events
from notebook_api.config import Settings
from notebook_api.db.models import CellExecution, CellRun, Notebook
from notebook_api.notebooks.access import lock_notebook
from notebook_api.query.engine import QueryResult
from notebook_api.query.runner import _KILL_GRACE_SECONDS, QueryFailedError
from notebook_api.query.validate import QueryRejectedError

# Older runs of a cell are pruned. A few are kept, not just the latest, so a
# client that is a moment behind can still load the run it was told about.
RUNS_KEPT_PER_CELL = 3
# Time for the work around the query itself: parsing the SQL, and storing a
# result of up to QUERY_MAX_RESULT_BYTES. A conservative allowance, not a
# measured one.
LOCK_MARGIN_SECONDS = 10.0
# How often a joiner in another API process checks whether the execution it
# joined has finished.
POLL_INTERVAL_SECONDS = 0.2
# A claim can lose to an execution that finishes before the loser looks it
# up; it then simply tries again. More than a couple of rounds means the cell
# is being run continuously.
CLAIM_ATTEMPTS = 3
# Failures of recent executions in this process, so a joiner that arrives
# just after one finished still gets its exact reason.
_RECENT_FAILURES_KEPT = 256


def lock_ttl_seconds(settings: Settings) -> float:
    """How long a lock row may live before anyone may take it over.

    It must outlast the longest healthy execution, or a second execution
    could start while the first is still running:
        waiting for a free query worker   QUERY_QUEUE_TIMEOUT_SECONDS
      + the query itself                  QUERY_TIMEOUT_SECONDS
      + the runner's kill grace           (how long past the timeout the runner
                                           waits for an answer before killing)
      + parsing and storing               LOCK_MARGIN_SECONDS
    With the default settings that's 5 + 10 + 2 + 10 = 27 seconds.
    """
    return (
        settings.query_queue_timeout_seconds
        + settings.query_timeout_seconds
        + _KILL_GRACE_SECONDS
        + LOCK_MARGIN_SECONDS
    )


class Runner(Protocol):
    """What executions need from the query runner (QueryRunner in production)."""

    async def run(self, sql: str) -> QueryResult: ...


@dataclass(frozen=True)
class Stored:
    """The execution stored a run (which may be a query error, also a run)."""

    run: CellRun


@dataclass(frozen=True)
class Failed:
    """The query service failed (busy, crashed); nothing was stored."""

    kind: str
    message: str


@dataclass(frozen=True)
class Gone:
    """The notebook was deleted."""


Outcome = Stored | Failed | Gone


@dataclass(frozen=True)
class _Held:
    """The lock is held by another execution (None: it ended as we looked)."""

    execution_id: uuid.UUID | None


_JOIN_FAILED = Failed("busy", "The run you joined didn't finish. Run the cell again.")
_SHUTTING_DOWN = Failed("unavailable", "The server is restarting. Run the cell again.")


class Executions:
    """Runs cells under the per-cell lock. One per API process (app.state)."""

    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        runner: Runner,
        lock_ttl_seconds: float,
        poll_interval_seconds: float = POLL_INTERVAL_SECONDS,
    ) -> None:
        self._sessions = sessions
        self._runner = runner
        self._ttl = lock_ttl_seconds
        self._poll_interval = poll_interval_seconds
        # Executions started by this process, by execution ID. Holding the
        # tasks here also keeps them alive: asyncio only keeps weak references.
        self._tasks: dict[uuid.UUID, asyncio.Task[Outcome | _Held]] = {}
        self._recent_failures: OrderedDict[uuid.UUID, Failed] = OrderedDict()

    async def run(
        self,
        notebook_id: uuid.UUID,
        cell_id: str,
        sql: str,
        user_id: uuid.UUID,
        user_name: str,
    ) -> tuple[Outcome, bool]:
        """Run the cell, or join its execution in flight. Returns (outcome, joined)."""
        for _ in range(CLAIM_ATTEMPTS):
            execution_id = uuid.uuid4()
            task = asyncio.create_task(
                self._claim_and_execute(execution_id, notebook_id, cell_id, sql, user_id, user_name)
            )
            self._tasks[execution_id] = task
            task.add_done_callback(partial(self._forget, execution_id))
            # asyncio.wait, not awaiting the task: if this request is
            # cancelled, the wait ends but the execution carries on.
            await asyncio.wait({task})
            if task.cancelled():
                return _SHUTTING_DOWN, False
            claimed = task.result()  # an unexpected error (a bug) is raised here
            if not isinstance(claimed, _Held):
                return claimed, False
            if claimed.execution_id is not None:
                return await self._join(notebook_id, cell_id, claimed.execution_id), True
        return Failed("busy", "This cell is being run repeatedly. Try again in a moment."), False

    def _forget(self, execution_id: uuid.UUID, _task: object) -> None:
        self._tasks.pop(execution_id, None)

    async def close(self) -> None:
        """Stop every execution in flight (at shutdown); each releases its lock."""
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # --- the winner -------------------------------------------------------

    async def _claim_and_execute(
        self,
        execution_id: uuid.UUID,
        notebook_id: uuid.UUID,
        cell_id: str,
        sql: str,
        user_id: uuid.UUID,
        user_name: str,
    ) -> Outcome | _Held:
        # True once the lock row is known to be gone: never claimed, deleted
        # by this execution, or deleted along with the notebook.
        settled = False
        try:
            claim = await self._claim(execution_id, notebook_id, cell_id, user_id, user_name)
            if claim is not True:
                settled = True
                return claim
            outcome = await self._execute(execution_id, notebook_id, cell_id, sql)
            settled = True
            return outcome
        finally:
            if not settled:
                # Cancelled or failed part-way. Shielded: a second
                # cancellation must not interrupt the release itself.
                await asyncio.shield(self._release(execution_id, notebook_id, cell_id))

    async def _claim(
        self,
        execution_id: uuid.UUID,
        notebook_id: uuid.UUID,
        cell_id: str,
        user_id: uuid.UUID,
        user_name: str,
    ) -> Literal[True] | _Held | Gone:
        async with self._sessions() as session:
            if not await lock_notebook(session, notebook_id):
                return Gone()
            insert = pg_insert(CellExecution).values(
                notebook_id=notebook_id,
                cell_id=cell_id,
                execution_id=execution_id,
                started_by=user_id,
                started_at=func.now(),
                expires_at=func.now() + timedelta(seconds=self._ttl),
            )
            # One atomic statement: insert the lock, or take over a lock that
            # has expired. Two simultaneous claims can't both succeed.
            claim = insert.on_conflict_do_update(
                index_elements=[CellExecution.notebook_id, CellExecution.cell_id],
                set_={
                    "execution_id": insert.excluded.execution_id,
                    "started_by": insert.excluded.started_by,
                    "started_at": insert.excluded.started_at,
                    "expires_at": insert.excluded.expires_at,
                },
                where=CellExecution.expires_at <= func.now(),
            ).returning(CellExecution.started_at)
            started_at = (await session.execute(claim)).scalar_one_or_none()
            if started_at is None:
                holder = await session.scalar(
                    select(CellExecution.execution_id).where(
                        CellExecution.notebook_id == notebook_id, CellExecution.cell_id == cell_id
                    )
                )
                return _Held(holder)
            await events.notify(
                session,
                events.run_started(notebook_id, cell_id, execution_id, user_name, started_at),
            )
            await session.commit()
            return True

    async def _execute(
        self, execution_id: uuid.UUID, notebook_id: uuid.UUID, cell_id: str, sql: str
    ) -> Outcome:
        """Run the query (no transaction open meanwhile) and store its outcome.

        A query that fails because of the query itself (rejected, error,
        timeout) is still a run: it's stored and shown to everyone. Failures
        of the service (busy, crashed) are not stored, so the client can retry.
        """
        result: QueryResult | None = None
        error: dict[str, Any] | None = None
        try:
            result = await self._runner.run(sql)
        except QueryRejectedError as rejected:
            error = {"kind": "rejected", "message": str(rejected)}
        except QueryFailedError as failed:
            if failed.kind in ("busy", "crashed"):
                await self._release(execution_id, notebook_id, cell_id)
                failure = Failed(failed.kind, str(failed))
                self._remember_failure(execution_id, failure)
                return failure
            error = {"kind": failed.kind, "message": str(failed)}
        return await self._store(execution_id, notebook_id, cell_id, sql, result, error)

    async def _store(
        self,
        execution_id: uuid.UUID,
        notebook_id: uuid.UUID,
        cell_id: str,
        sql: str,
        result: QueryResult | None,
        error: dict[str, Any] | None,
    ) -> Outcome:
        async with self._sessions() as session:
            # Also the existence check: if the notebook was deleted while its
            # query ran, its lock row went with it and there's nothing to store.
            if not await lock_notebook(session, notebook_id):
                return Gone()
            run = CellRun(
                notebook_id=notebook_id,
                cell_id=cell_id,
                sql=sql,
                status="ok" if error is None else "error",
                result=dict(result) if result is not None else None,
                error=error,
                execution_id=execution_id,
                # clock_timestamp() is the actual time of the insert, i.e. when
                # the query finished, so "newest" means the run that completed last.
                created_at=func.clock_timestamp(),
            )
            session.add(run)
            await session.flush()
            await _prune_runs(session, run)
            # Only our own lock: if it expired and someone else took it over,
            # theirs stays. The run is stored and announced either way.
            await session.execute(
                delete(CellExecution).where(
                    CellExecution.notebook_id == notebook_id,
                    CellExecution.cell_id == cell_id,
                    CellExecution.execution_id == execution_id,
                )
            )
            await events.notify(
                session, events.run_finished(notebook_id, cell_id, execution_id, run.id)
            )
            await session.commit()
            await session.refresh(run)
            return Stored(run)

    async def _release(self, execution_id: uuid.UUID, notebook_id: uuid.UUID, cell_id: str) -> None:
        """Delete this execution's lock row, if it's still there, with no run stored.

        Touches only the lock row (never the notebook row), so it can't
        deadlock with a concurrent delete of the notebook.
        """
        async with self._sessions() as session:
            released = await session.scalar(
                delete(CellExecution)
                .where(
                    CellExecution.notebook_id == notebook_id,
                    CellExecution.cell_id == cell_id,
                    CellExecution.execution_id == execution_id,
                )
                .returning(CellExecution.execution_id)
            )
            if released is not None:
                await events.notify(
                    session, events.run_finished(notebook_id, cell_id, execution_id, None)
                )
            await session.commit()

    def _remember_failure(self, execution_id: uuid.UUID, failure: Failed) -> None:
        self._recent_failures[execution_id] = failure
        while len(self._recent_failures) > _RECENT_FAILURES_KEPT:
            self._recent_failures.popitem(last=False)

    # --- joiners ----------------------------------------------------------

    async def _join(self, notebook_id: uuid.UUID, cell_id: str, execution_id: uuid.UUID) -> Outcome:
        """Wait for another execution of this cell and return its outcome."""
        task = self._tasks.get(execution_id)
        if task is not None:
            # Started by this process: wait for it directly. (asyncio.wait
            # never cancels the task, even if this request is cancelled.)
            await asyncio.wait({task}, timeout=self._ttl)
            if not task.done():
                return _JOIN_FAILED
            if task.cancelled():
                return _SHUTTING_DOWN
            if task.exception() is not None:
                # A bug in that execution; it surfaces in its own request.
                return _JOIN_FAILED
            outcome = task.result()
            if not isinstance(outcome, _Held):
                return outcome
        return await self._poll(notebook_id, cell_id, execution_id)

    async def _poll(self, notebook_id: uuid.UUID, cell_id: str, execution_id: uuid.UUID) -> Outcome:
        """Wait for an execution (possibly in another API process) by polling Postgres.

        Bounded by the lock's expiry: an execution whose lock expired is
        presumed dead. Each check is its own short transaction, so nothing
        stays open while waiting.
        """
        loop = asyncio.get_running_loop()
        # A local bound as well, in case the database clock and ours disagree.
        deadline = loop.time() + self._ttl + 1.0
        while True:
            async with self._sessions() as session:
                # The lock is checked before the run, never the other way
                # round. A finishing execution stores its run and deletes its
                # lock in one transaction, so once the lock is seen gone, that
                # run (if there is one) is already visible to the next query.
                holder = (
                    await session.execute(
                        select(
                            CellExecution.execution_id, CellExecution.expires_at <= func.now()
                        ).where(
                            CellExecution.notebook_id == notebook_id,
                            CellExecution.cell_id == cell_id,
                        )
                    )
                ).first()
                running = holder is not None and holder[0] == execution_id and not holder[1]
                if not running:
                    run = await session.scalar(
                        select(CellRun).where(
                            CellRun.execution_id == execution_id,
                            CellRun.notebook_id == notebook_id,
                        )
                    )
                    if run is not None:
                        return Stored(run)
                    if await session.get(Notebook, notebook_id) is None:
                        return Gone()
                    return self._recent_failures.get(execution_id, _JOIN_FAILED)
            if loop.time() >= deadline:
                return _JOIN_FAILED
            await asyncio.sleep(self._poll_interval)


async def _prune_runs(session: AsyncSession, new_run: CellRun) -> None:
    """Keep `new_run` plus the newest RUNS_KEPT_PER_CELL - 1 other runs of its cell.

    The new run is excluded explicitly, so pruning can never delete the run
    that is being returned. Runs from transactions that haven't committed yet
    are invisible here and are left alone.
    """
    same_cell = (
        CellRun.notebook_id == new_run.notebook_id,
        CellRun.cell_id == new_run.cell_id,
        CellRun.id != new_run.id,
    )
    keep_others = (
        select(CellRun.id)
        .where(*same_cell)
        .order_by(CellRun.created_at.desc(), CellRun.id.desc())
        .limit(RUNS_KEPT_PER_CELL - 1)
    )
    await session.execute(delete(CellRun).where(*same_cell, CellRun.id.not_in(keep_others)))
