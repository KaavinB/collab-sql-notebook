"""Storage bounds per notebook: stored runs across cells, and the AI request log."""

import asyncio
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from notebook_api.ai import service as service_module
from notebook_api.ai.pipeline import SchemaContext
from notebook_api.ai.service import AiService, AiTask, Done, decide, prune_ai_rows
from notebook_api.config import Settings
from notebook_api.db.session import create_engine, make_sessionmaker
from notebook_api.notebooks import executions as executions_module
from notebook_api.notebooks.executions import Executions, Stored
from notebook_api.query.engine import QueryResult
from tests.ai_fakes import ScriptedClient, TableValidator, reply, sql_reply
from tests.fixtures import sql_connection

pytestmark = pytest.mark.anyio

RESULT: QueryResult = {
    "columns": [{"name": "x", "type": "INTEGER"}],
    "rows": [[1]],
    "row_count": 1,
    "truncated": False,
    "duration_ms": 1.0,
}


class InstantRunner:
    async def run(self, sql: str) -> QueryResult:
        return RESULT


@pytest.fixture
async def sessions(clean_db: str) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_engine(clean_db)
    yield make_sessionmaker(engine)
    await engine.dispose()


def _seed(url: str) -> tuple[uuid.UUID, uuid.UUID]:
    notebook_id, user_id = uuid.uuid4(), uuid.uuid4()
    with sql_connection(url) as conn:
        conn.execute("INSERT INTO users (id, name) VALUES (%s, 'Ada')", (user_id,))
        conn.execute("INSERT INTO notebooks (id, title) VALUES (%s, 't')", (notebook_id,))
    return notebook_id, user_id


def _rows(url: str, query: str, *params: Any) -> list[tuple[Any, ...]]:
    with sql_connection(url) as conn:
        return [tuple(row) for row in conn.execute(query, params).fetchall()]


def test_the_settings_have_bounded_defaults() -> None:
    settings = Settings()
    assert settings.query_runs_kept_per_notebook == executions_module.RUNS_KEPT_PER_NOTEBOOK
    assert settings.ai_requests_kept_per_notebook == service_module.REQUESTS_KEPT_PER_NOTEBOOK
    with pytest.raises(ValueError, match="greater than or equal to 3"):
        Settings(query_runs_kept_per_notebook=2)


# --- runs ---------------------------------------------------------------------------------


async def _run(executions: Executions, notebook_id: uuid.UUID, cell: str, user: uuid.UUID) -> Any:
    outcome, _ = await executions.run(notebook_id, cell, "select 1", user, "Ada")
    assert isinstance(outcome, Stored)
    return outcome.run.id


async def test_runs_for_made_up_cells_are_capped_per_notebook(
    sessions: async_sessionmaker[AsyncSession], clean_db: str
) -> None:
    notebook_id, user_id = _seed(clean_db)
    other_notebook, _ = _seed(clean_db)
    executions = Executions(
        sessions, InstantRunner(), lock_ttl_seconds=30, runs_kept_per_notebook=5
    )
    await _run(executions, other_notebook, "elsewhere", user_id)
    ids = [await _run(executions, notebook_id, f"made-up-{i}", user_id) for i in range(8)]
    kept = {
        row[0]
        for row in _rows(clean_db, "SELECT id FROM cell_runs WHERE notebook_id = %s", notebook_id)
    }
    assert kept == set(ids[-5:])  # the newest five; the oldest cells' runs went first
    # Another notebook's runs are its own.
    assert _rows(
        clean_db, "SELECT count(*) FROM cell_runs WHERE notebook_id = %s", other_notebook
    ) == [(1,)]


async def test_each_cells_latest_run_outlasts_older_runs_of_busy_cells(
    sessions: async_sessionmaker[AsyncSession], clean_db: str
) -> None:
    notebook_id, user_id = _seed(clean_db)
    executions = Executions(
        sessions, InstantRunner(), lock_ttl_seconds=30, runs_kept_per_notebook=5
    )
    quiet = await _run(executions, notebook_id, "quiet", user_id)  # the oldest run
    busy = [await _run(executions, notebook_id, "busy", user_id) for _ in range(3)]
    current = [await _run(executions, notebook_id, "current", user_id) for _ in range(3)]
    kept = {
        row[0]
        for row in _rows(clean_db, "SELECT id FROM cell_runs WHERE notebook_id = %s", notebook_id)
    }
    # Seven runs, room for five. The cell being run keeps its three; then
    # each cell's latest; the busy cell's two older runs went.
    assert kept == {*current, busy[-1], quiet}


async def test_the_run_being_returned_is_never_pruned(
    sessions: async_sessionmaker[AsyncSession], clean_db: str
) -> None:
    notebook_id, user_id = _seed(clean_db)
    executions = Executions(
        sessions, InstantRunner(), lock_ttl_seconds=30, runs_kept_per_notebook=3
    )
    for i in range(5):
        run_id = await _run(executions, notebook_id, f"c{i}", user_id)
        assert _rows(clean_db, "SELECT count(*) FROM cell_runs WHERE id = %s", run_id) == [(1,)]
    assert _rows(clean_db, "SELECT count(*) FROM cell_runs") == [(3,)]


async def test_two_runs_storing_at_once_both_prune_without_deadlock(
    sessions: async_sessionmaker[AsyncSession], clean_db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    notebook_id, user_id = _seed(clean_db)
    executions = Executions(
        sessions, InstantRunner(), lock_ttl_seconds=30, runs_kept_per_notebook=4
    )
    for i in range(4):
        await _run(executions, notebook_id, f"old-{i}", user_id)

    real_prune = executions_module._prune_notebook_runs
    pruned = asyncio.Event()

    async def slow_prune(session: AsyncSession, run: Any, kept: int) -> None:
        # Hold the transaction open after pruning, so the other store would
        # prune while this one's deletes are uncommitted. Without the
        # exclusive notebook lock, both then delete the same oldest run and
        # the notebook ends one over its cap.
        await real_prune(session, run, kept)
        pruned.set()
        await asyncio.sleep(0.5)

    monkeypatch.setattr(executions_module, "_prune_notebook_runs", slow_prune)
    first, second = await asyncio.wait_for(
        asyncio.gather(
            _run(executions, notebook_id, "new-a", user_id),
            _run(executions, notebook_id, "new-b", user_id),
        ),
        timeout=20,
    )
    kept = {
        row[0]
        for row in _rows(clean_db, "SELECT id FROM cell_runs WHERE notebook_id = %s", notebook_id)
    }
    assert len(kept) == 4
    assert {first, second} <= kept


# --- the AI log ---------------------------------------------------------------------------


def _ai_request(url: str, notebook_id: uuid.UUID, status: str, age_seconds: int) -> uuid.UUID:
    request_id = uuid.uuid4()
    with sql_connection(url) as conn:
        conn.execute(
            "INSERT INTO ai_requests (id, notebook_id, cell_id, kind, prompt, model, status, "
            "attempts, input_tokens, output_tokens, created_at) VALUES (%s, %s, 'c', 'generate', "
            "'{}', 'm', %s, '[]', 0, 0, now() - make_interval(secs => %s))",
            (request_id, notebook_id, status, age_seconds),
        )
    return request_id


def _ai_suggestion(url: str, notebook_id: uuid.UUID, request_id: uuid.UUID, status: str) -> None:
    with sql_connection(url) as conn:
        conn.execute(
            "INSERT INTO ai_suggestions (id, notebook_id, cell_id, request_id, kind, status, sql, "
            "explanation, valid) VALUES (%s, %s, 'c', %s, 'generate', %s, 'SELECT 1', 'x', true)",
            (uuid.uuid4(), notebook_id, request_id, status),
        )


async def test_the_ai_log_keeps_the_newest_finished_requests_and_everything_in_play(
    sessions: async_sessionmaker[AsyncSession], clean_db: str
) -> None:
    notebook_id, _ = _seed(clean_db)
    other_notebook, _ = _seed(clean_db)
    # Oldest first: ages 100, 90, ... seconds.
    old_failed = _ai_request(clean_db, notebook_id, "failed", 100)
    old_accepted = _ai_request(clean_db, notebook_id, "succeeded", 90)
    _ai_suggestion(clean_db, notebook_id, old_accepted, "accepted")
    old_pending = _ai_request(clean_db, notebook_id, "succeeded", 80)
    _ai_suggestion(clean_db, notebook_id, old_pending, "pending")
    old_running = _ai_request(clean_db, notebook_id, "running", 70)
    newer_rejected = _ai_request(clean_db, notebook_id, "succeeded", 60)
    _ai_suggestion(clean_db, notebook_id, newer_rejected, "rejected")
    newer_failed = _ai_request(clean_db, notebook_id, "failed", 50)
    current = _ai_request(clean_db, notebook_id, "failed", 200)  # finished last, asked first
    elsewhere = _ai_request(clean_db, other_notebook, "failed", 300)

    async with sessions() as session:
        await prune_ai_rows(session, notebook_id, current, kept=2)
        await session.commit()

    left = {row[0] for row in _rows(clean_db, "SELECT id FROM ai_requests")}
    assert left == {old_pending, old_running, newer_rejected, newer_failed, current, elsewhere}
    assert old_failed not in left and old_accepted not in left  # the oldest finished went
    # The pruned request's decided suggestion went with it; the others stay.
    suggestions = _rows(clean_db, "SELECT request_id, status FROM ai_suggestions ORDER BY status")
    assert suggestions == [(old_pending, "pending"), (newer_rejected, "rejected")]


class _Schema:
    async def get(self) -> SchemaContext:
        return SchemaContext(dialect="duckdb", text="Table trips")


async def test_the_service_prunes_its_log_as_requests_finish(
    sessions: async_sessionmaker[AsyncSession], clean_db: str
) -> None:
    notebook_id, user_id = _seed(clean_db)
    client = ScriptedClient([sql_reply("SELECT 1")])
    service = AiService(
        sessions, client, "m", _Schema(), TableValidator(), requests_kept_per_notebook=2
    )
    try:
        for i in range(4):
            outcome = await service.request(
                notebook_id, f"c{i}", user_id, "Ada", AiTask(kind="generate", prompt="q")
            )
            assert isinstance(outcome, Done)
            async with sessions() as session:
                decided = await decide(
                    session, notebook_id, outcome.suggestion.id, user_id, "rejected"
                )
                assert not isinstance(decided, str)
        # A failed request (the model refused) counts toward the cap too.
        client.script = [reply("no", stop_reason="refusal")]
        await service.request(
            notebook_id, "c9", user_id, "Ada", AiTask(kind="generate", prompt="q")
        )
    finally:
        await service.close()
    cells = sorted(row[0] for row in _rows(clean_db, "SELECT cell_id FROM ai_requests"))
    assert cells == ["c3", "c9"]
    assert _rows(clean_db, "SELECT count(*) FROM ai_suggestions") == [(1,)]


async def test_a_pending_suggestion_survives_the_cap(
    sessions: async_sessionmaker[AsyncSession], clean_db: str
) -> None:
    notebook_id, user_id = _seed(clean_db)
    service = AiService(
        sessions,
        ScriptedClient([sql_reply("SELECT 1")]),
        "m",
        _Schema(),
        TableValidator(),
        requests_kept_per_notebook=1,
    )
    try:
        for i in range(3):  # nobody decides: all three stay pending
            outcome = await service.request(
                notebook_id, f"c{i}", user_id, "Ada", AiTask(kind="generate", prompt="q")
            )
            assert isinstance(outcome, Done)
    finally:
        await service.close()
    assert _rows(clean_db, "SELECT count(*) FROM ai_suggestions WHERE status = 'pending'") == [(3,)]
    assert _rows(clean_db, "SELECT count(*) FROM ai_requests") == [(3,)]


async def test_two_ai_requests_finishing_at_once_both_prune(
    sessions: async_sessionmaker[AsyncSession], clean_db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    notebook_id, user_id = _seed(clean_db)
    for age in (100, 90, 80):
        _ai_request(clean_db, notebook_id, "failed", age)
    real_prune = service_module.prune_ai_rows

    async def slow_prune(
        session: AsyncSession, nb: uuid.UUID, current: uuid.UUID, kept: int
    ) -> None:
        # As for runs: hold the transaction open after pruning, so the other
        # request would prune while these deletes are uncommitted.
        await real_prune(session, nb, current, kept)
        await asyncio.sleep(0.5)

    monkeypatch.setattr(service_module, "prune_ai_rows", slow_prune)
    service = AiService(
        sessions,
        ScriptedClient([reply("no", stop_reason="refusal")]),
        "m",
        _Schema(),
        TableValidator(),
        requests_kept_per_notebook=3,
    )
    try:
        await asyncio.wait_for(
            asyncio.gather(
                *(
                    service.request(
                        notebook_id, cell, user_id, "Ada", AiTask(kind="generate", prompt="q")
                    )
                    for cell in ("a", "b")
                )
            ),
            timeout=20,
        )
    finally:
        await service.close()
    assert _rows(clean_db, "SELECT count(*) FROM ai_requests") == [(3,)]
    cells = {row[0] for row in _rows(clean_db, "SELECT cell_id FROM ai_requests")}
    assert {"a", "b"} <= cells
