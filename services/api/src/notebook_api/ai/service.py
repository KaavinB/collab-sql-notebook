"""Running AI requests for notebook cells: one at a time per cell, logged, announced.

A request (generate, fix or explain) for a cell:

0. Is admitted: at most MAX_IN_FLIGHT_PER_USER of one person's requests and
   AI_MAX_CONCURRENT requests in all run at once in this process (counted
   in memory, so each API process has its own counts).
1. Claims the cell in a short transaction: no other AI request for the cell
   may be in flight (409 otherwise). A suggestion for the cell still waiting
   for a decision is superseded (rejected, NOTIFY `ai_resolved`). It inserts
   the `ai_requests` row as 'running' and sends NOTIFY `ai_started`, so the
   sync server can show everyone that the assistant is working on the cell.
2. Builds the prompt and calls the model (validating and repairing), with
   no database transaction open: that can take many seconds, and an open
   transaction would hold a pooled connection the whole time.
3. In one transaction, completes the `ai_requests` row (attempts, tokens,
   latency, outcome) and either stores the suggestion (NOTIFY
   `ai_suggestion`) or records the failure (NOTIFY `ai_failed`).

The work runs in its own asyncio task, not in the HTTP request, so a person
who closes the page doesn't cancel it: everyone else still sees the
suggestion. If the task itself is cancelled (shutdown) or fails, the row is
marked failed in a shielded `finally`, so it never stays 'running'. A row
left 'running' by an API process that died is treated as abandoned after
STALE_AFTER_SECONDS: the next request for that cell marks it failed.

Lock order (no deadlocks with a concurrent notebook delete): every
transaction here locks the notebook row first, then touches AI rows.
"""

import asyncio
import dataclasses
import logging
import time
import uuid
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import timedelta
from functools import partial
from typing import Any, Literal, Protocol

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from notebook_api import events
from notebook_api.ai.pipeline import (
    AssistantUnavailableError,
    Attempt,
    GenerationResult,
    ModelClient,
    SchemaContext,
    Validator,
    explain_sql,
    fix_sql,
    generate_sql,
)
from notebook_api.db.models import AiRequest, AiSuggestion
from notebook_api.notebooks.access import lock_notebook

logger = logging.getLogger(__name__)

Kind = Literal["generate", "fix", "explain"]
Decision = Literal["accepted", "rejected"]

# The longest one AI request may take, model calls and validation included
# (up to three model calls). Kept under STALE_AFTER_SECONDS, so a live
# request is never mistaken for an abandoned one.
REQUEST_DEADLINE_SECONDS = 100.0
# A 'running' request older than this was abandoned (its API process died).
# Two minutes: the same bound the sync server uses to stop showing a cell's
# AI state as "thinking".
STALE_AFTER_SECONDS = 120.0

# Per-user rate limit: a guard against runaway cost and abuse (each request
# can make up to three model calls), not a tuned quota. Held in this
# process's memory, so with several API processes each enforces it on its
# own (the effective limit is multiplied) and a restart resets it.
RATE_LIMIT_REQUESTS = 20
RATE_LIMIT_WINDOW_SECONDS = 300.0
# At most this many of one person's requests run at once (on any cells).
# Without it, one person could start a request on every cell (or on made-up
# cell IDs) at the same moment. Two leaves room to ask about a second cell
# while the first is still being answered. In-memory, per process (as above).
MAX_IN_FLIGHT_PER_USER = 2

TOO_SLOW = "The AI assistant took too long to answer. Try again."
CELL_BUSY = "The AI assistant is already working on this cell."
STOPPED = "The AI assistant stopped before answering."
ABANDONED = "The AI assistant stopped before answering (the server restarted)."


@dataclass(frozen=True)
class AiTask:
    """What was asked, as validated by the route."""

    kind: Kind
    prompt: str | None = None  # generate: the question
    sql: str | None = None  # fix, explain: the cell's SQL
    error: str | None = None  # fix: the error it failed with

    def logged_prompt(self) -> dict[str, str]:
        """The request's input, for `ai_requests.prompt`."""
        fields = {"prompt": self.prompt, "sql": self.sql, "error": self.error}
        return {name: value for name, value in fields.items() if value is not None}


@dataclass(frozen=True)
class Done:
    suggestion: AiSuggestion


@dataclass(frozen=True)
class Failed:
    message: str  # safe to show users


@dataclass(frozen=True)
class Busy:
    """The cell already has an AI request in flight, or a suggestion waiting for a decision."""

    message: str


@dataclass(frozen=True)
class UserBusy:
    """This person already has MAX_IN_FLIGHT_PER_USER requests running."""


@dataclass(frozen=True)
class Overloaded:
    """The process is running its maximum number of AI requests."""


@dataclass(frozen=True)
class Gone:
    """The notebook was deleted."""


Outcome = Done | Failed | Busy | UserBusy | Overloaded | Gone


class SchemaSource(Protocol):
    async def get(self) -> SchemaContext: ...


class RateLimiter:
    """At most `limit` acquisitions per key in any `window_seconds` (a sliding window)."""

    def __init__(
        self,
        limit: int = RATE_LIMIT_REQUESTS,
        window_seconds: float = RATE_LIMIT_WINDOW_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._limit = limit
        self._window = window_seconds
        self._clock = clock
        self._used: dict[uuid.UUID, deque[float]] = {}

    def try_acquire(self, key: uuid.UUID) -> bool:
        now = self._clock()
        used = self._used.setdefault(key, deque())
        while used and used[0] <= now - self._window:
            used.popleft()
        if len(used) >= self._limit:
            return False
        used.append(now)
        if len(self._used) > 10_000:
            self._forget_idle(now)
        return True

    def refund(self, key: uuid.UUID) -> None:
        """Give back the latest acquisition (the request didn't start)."""
        used = self._used.get(key)
        if used:
            used.pop()

    def _forget_idle(self, now: float) -> None:
        # Bounds memory: keys whose every acquisition has expired are dropped.
        for key in [
            k for k, used in self._used.items() if not used or used[-1] <= now - self._window
        ]:
            del self._used[key]


class AiService:
    """Runs AI requests for cells. One per API process (app.state.ai)."""

    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        client: ModelClient,
        model_name: str,
        schema: SchemaSource,
        validator: Validator,
        *,
        rate_limiter: RateLimiter | None = None,
        max_concurrent: int = 4,
        max_per_user: int = MAX_IN_FLIGHT_PER_USER,
        logged_settings: dict[str, Any] | None = None,
        deadline_seconds: float = REQUEST_DEADLINE_SECONDS,
        stale_after_seconds: float = STALE_AFTER_SECONDS,
    ) -> None:
        """`max_concurrent`: requests this process runs at once (AI_MAX_CONCURRENT).
        `logged_settings`: the model settings (effort, fallbacks) stored with
        each request's prompt in the log."""
        self._sessions = sessions
        self.client = client
        self._model_name = model_name
        self._schema = schema
        self._validator = validator
        self.rate_limiter = rate_limiter or RateLimiter()
        self._max_concurrent = max_concurrent
        self._max_per_user = max_per_user
        self._logged_settings = dict(logged_settings or {})
        self._deadline = deadline_seconds
        self._stale_after = stale_after_seconds
        # Requests in flight. Holding the tasks also keeps them alive:
        # asyncio only keeps weak references to tasks.
        self._tasks: set[asyncio.Task[Outcome]] = set()
        # Requests in flight per person. Counted from admission until the
        # work task ends (which can be after the HTTP request has gone).
        self._per_user: dict[uuid.UUID, int] = {}

    async def close(self) -> None:
        """Stop every request in flight (at shutdown); each marks its row failed."""
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        close: Callable[[], Awaitable[None]] | None = getattr(self.client, "close", None)
        if close is not None:
            await close()

    async def request(
        self,
        notebook_id: uuid.UUID,
        cell_id: str,
        user_id: uuid.UUID,
        user_name: str,
        task: AiTask,
    ) -> Outcome:
        # Checked and counted with no await in between, so concurrent
        # requests on this event loop can't both slip under a limit.
        if self._per_user.get(user_id, 0) >= self._max_per_user:
            return UserBusy()
        if len(self._tasks) >= self._max_concurrent:
            # Refused rather than queued: a queue would hold people's
            # requests (and their HTTP connections) for an unbounded time.
            return Overloaded()
        work = asyncio.create_task(
            self._claim_and_run(notebook_id, cell_id, user_id, user_name, task)
        )
        self._tasks.add(work)
        self._per_user[user_id] = self._per_user.get(user_id, 0) + 1
        work.add_done_callback(partial(self._forget, user_id))
        # asyncio.wait, not awaiting the task: if this HTTP request is
        # cancelled (the page closed), the wait ends but the work carries on.
        await asyncio.wait({work})
        if work.cancelled():
            return Failed(STOPPED)
        return work.result()  # an unexpected error (a bug) is raised here

    def _forget(self, user_id: uuid.UUID, work: asyncio.Task[Outcome]) -> None:
        self._tasks.discard(work)
        remaining = self._per_user.get(user_id, 1) - 1
        if remaining > 0:
            self._per_user[user_id] = remaining
        else:
            self._per_user.pop(user_id, None)

    async def _claim_and_run(
        self,
        notebook_id: uuid.UUID,
        cell_id: str,
        user_id: uuid.UUID,
        user_name: str,
        task: AiTask,
    ) -> Outcome:
        request_id = uuid.uuid4()
        # True once the request's row is known to be finished, or never
        # created. Until then, any exit (a cancellation at shutdown, even
        # one landing right after the claim committed, or a bug) marks the
        # row failed in the `finally`.
        settled = False
        try:
            claimed = await self._claim(request_id, notebook_id, cell_id, user_id, user_name, task)
            if claimed is not None:
                settled = True
                return claimed
            started = time.monotonic()
            try:
                async with asyncio.timeout(self._deadline):
                    result: GenerationResult | Failed = await self._generate(task)
                attempts = result.attempts if isinstance(result, GenerationResult) else []
            except AssistantUnavailableError as error:
                result, attempts = Failed(error.message), error.attempts
            except TimeoutError:
                result, attempts = Failed(TOO_SLOW), []
            latency_ms = round((time.monotonic() - started) * 1000)
            outcome = await self._finish(
                request_id, notebook_id, cell_id, task, result, attempts, latency_ms
            )
            settled = True
            return outcome
        finally:
            if not settled:
                # Cancelled (shutdown) or a bug. Shielded: a second
                # cancellation must not interrupt marking the row failed.
                await asyncio.shield(self._abandon(request_id, notebook_id, cell_id))

    async def _claim(
        self,
        request_id: uuid.UUID,
        notebook_id: uuid.UUID,
        cell_id: str,
        user_id: uuid.UUID,
        user_name: str,
        task: AiTask,
    ) -> Busy | Gone | None:
        """Insert the 'running' row and send ai_started, unless the cell is busy."""
        async with self._sessions() as session:
            # Exclusive: "check for a running request, then insert one" must
            # not interleave with another claim in this notebook.
            if not await lock_notebook(session, notebook_id, exclusive=True):
                return Gone()
            same_cell = (AiRequest.notebook_id == notebook_id, AiRequest.cell_id == cell_id)
            abandoned = (
                await session.scalars(
                    update(AiRequest)
                    .where(
                        *same_cell,
                        AiRequest.status == "running",
                        AiRequest.created_at < func.now() - timedelta(seconds=self._stale_after),
                    )
                    .values(status="failed", error=ABANDONED, finished_at=func.now())
                    .returning(AiRequest.id)
                )
            ).all()
            for stale_id in abandoned:
                await events.notify(
                    session, events.ai_failed(notebook_id, cell_id, stale_id, ABANDONED)
                )
            running = await session.scalar(
                select(AiRequest.id).where(*same_cell, AiRequest.status == "running").limit(1)
            )
            if running is not None:
                await session.commit()  # keep the abandoned rows' cleanup
                return Busy(CELL_BUSY)
            # A new request supersedes any suggestion for the cell still
            # waiting for a decision: it's rejected, by nobody (decided_by
            # NULL). Asking again means the old answer wasn't wanted, and a
            # suggestion that never reached the document (the sync server
            # was down when it was announced) would otherwise stay pending
            # with no way to clear it. ai_resolved goes out before
            # ai_started, in this transaction: the sync server applies a
            # notebook's events in order, and clears the old suggestion
            # before showing the new request.
            superseded = (
                await session.scalars(
                    update(AiSuggestion)
                    .where(
                        AiSuggestion.notebook_id == notebook_id,
                        AiSuggestion.cell_id == cell_id,
                        AiSuggestion.status == "pending",
                    )
                    .values(status="rejected", decided_by=None, decided_at=func.now())
                    .returning(AiSuggestion.id)
                )
            ).all()
            for suggestion_id in superseded:
                await events.notify(
                    session, events.ai_resolved(notebook_id, cell_id, suggestion_id, "rejected")
                )
            prompt: dict[str, Any] = {**task.logged_prompt(), **self._logged_settings}
            if superseded:
                prompt["superseded"] = [str(suggestion_id) for suggestion_id in superseded]
            session.add(
                AiRequest(
                    id=request_id,
                    notebook_id=notebook_id,
                    cell_id=cell_id,
                    user_id=user_id,
                    kind=task.kind,
                    prompt=prompt,
                    model=self._model_name,
                    status="running",
                    attempts=[],
                    input_tokens=0,
                    output_tokens=0,
                )
            )
            await session.flush()
            await events.notify(
                session, events.ai_started(notebook_id, cell_id, request_id, task.kind, user_name)
            )
            await session.commit()
            return None

    async def _generate(self, task: AiTask) -> GenerationResult:
        schema = await self._schema.get()
        if task.kind == "generate":
            return await generate_sql(
                question=task.prompt or "",
                schema=schema,
                validator=self._validator,
                client=self.client,
            )
        if task.kind == "fix":
            return await fix_sql(
                sql=task.sql or "",
                error=task.error or "",
                schema=schema,
                validator=self._validator,
                client=self.client,
            )
        return await explain_sql(sql=task.sql or "", schema=schema, client=self.client)

    async def _finish(
        self,
        request_id: uuid.UUID,
        notebook_id: uuid.UUID,
        cell_id: str,
        task: AiTask,
        result: GenerationResult | Failed,
        attempts: list[Attempt],
        latency_ms: int,
    ) -> Outcome:
        """In one transaction: complete the request's row, store the suggestion or the failure."""
        if isinstance(result, GenerationResult) and not succeeded(task.kind, result):
            result = Failed(result.explanation)
        async with self._sessions() as session:
            if not await lock_notebook(session, notebook_id):
                return Gone()  # deleted meanwhile; its AI rows went with it
            row = await session.scalar(
                select(AiRequest).where(AiRequest.id == request_id).with_for_update()
            )
            if row is None:
                return Gone()
            if row.status != "running":
                # Marked abandoned by another request: too late to show anything.
                return Failed(STOPPED)
            row.attempts = [_attempt_log(attempt) for attempt in attempts]
            row.input_tokens = sum(attempt.input_tokens for attempt in attempts)
            row.output_tokens = sum(attempt.output_tokens for attempt in attempts)
            row.latency_ms = latency_ms
            row.finished_at = func.now()
            if isinstance(result, Failed):
                row.status = "failed"
                row.error = result.message
                await events.notify(
                    session, events.ai_failed(notebook_id, cell_id, request_id, result.message)
                )
                await session.commit()
                return result
            row.status = "succeeded"
            suggestion = AiSuggestion(
                notebook_id=notebook_id,
                cell_id=cell_id,
                request_id=request_id,
                kind=task.kind,
                status="pending",
                sql=result.sql,
                explanation=result.explanation,
                base_sql=task.sql,
                valid=result.valid,
            )
            session.add(suggestion)
            await session.flush()
            await events.notify(
                session, events.ai_suggestion(notebook_id, cell_id, request_id, suggestion.id)
            )
            await session.commit()
            await session.refresh(suggestion)
            return Done(suggestion)

    async def _abandon(self, request_id: uuid.UUID, notebook_id: uuid.UUID, cell_id: str) -> None:
        """Mark the request failed if it's still running (shutdown or a bug)."""
        try:
            async with self._sessions() as session:
                if not await lock_notebook(session, notebook_id):
                    return
                ended = await session.scalar(
                    update(AiRequest)
                    .where(AiRequest.id == request_id, AiRequest.status == "running")
                    .values(status="failed", error=STOPPED, finished_at=func.now())
                    .returning(AiRequest.id)
                )
                if ended is not None:
                    await events.notify(
                        session, events.ai_failed(notebook_id, cell_id, request_id, STOPPED)
                    )
                await session.commit()
        except Exception:
            # Nothing more can be done here; the stale-request rule and the
            # sync server's two-minute bound clean up after it.
            logger.exception("could not mark AI request %s failed", request_id)


def succeeded(kind: Kind, result: GenerationResult) -> bool:
    """Whether the result is worth showing as a suggestion.

    A query that never passed validation is still shown (marked invalid);
    only "no query at all" (or no explanation) is a failure.
    """
    if kind == "explain":
        return bool(result.attempts) and result.attempts[-1].error is None
    return result.sql is not None


def _attempt_log(attempt: Attempt) -> dict[str, Any]:
    return dataclasses.asdict(attempt)


async def decide(
    session: AsyncSession,
    notebook_id: uuid.UUID,
    suggestion_id: uuid.UUID,
    user_id: uuid.UUID,
    decision: Decision,
) -> AiSuggestion | Literal["not_found", "decided"]:
    """Accept or reject a pending suggestion and send ai_resolved, in one transaction.

    The accepted SQL itself is applied to the cell by the person who
    accepted it, as their own edit in the document; this only records the
    decision. Only a pending suggestion can be decided, once.
    """
    if not await lock_notebook(session, notebook_id):
        return "not_found"
    decided: AiSuggestion | None = await session.scalar(
        update(AiSuggestion)
        .where(
            AiSuggestion.id == suggestion_id,
            AiSuggestion.notebook_id == notebook_id,
            AiSuggestion.status == "pending",
        )
        .values(status=decision, decided_by=user_id, decided_at=func.now())
        .returning(AiSuggestion)
    )
    if decided is None:
        exists = await session.scalar(
            select(AiSuggestion.id).where(
                AiSuggestion.id == suggestion_id, AiSuggestion.notebook_id == notebook_id
            )
        )
        await session.rollback()
        return "decided" if exists is not None else "not_found"
    await events.notify(
        session, events.ai_resolved(notebook_id, decided.cell_id, decided.id, decision)
    )
    await session.commit()
    return decided
