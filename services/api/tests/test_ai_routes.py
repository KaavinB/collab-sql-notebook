"""AI routes and service: roles, one request per cell, rate limit, logging, NOTIFY, decisions."""

import asyncio
import json
import threading
import uuid
from collections.abc import AsyncIterator, Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from notebook_api import events
from notebook_api.ai import pipeline
from notebook_api.ai.client import FAKE_MODEL_NAME, FAKE_VALID_SQL
from notebook_api.ai.pipeline import AssistantUnavailableError, ModelReply, SchemaContext
from notebook_api.ai.service import (
    ABANDONED,
    CELL_BUSY,
    STOPPED,
    AiService,
    AiTask,
    Done,
    Failed,
    RateLimiter,
    UserBusy,
)
from notebook_api.config import Settings
from notebook_api.db.session import create_engine, make_sessionmaker
from notebook_api.main import create_app
from tests.ai_fakes import ScriptedClient, TableValidator, reply, sql_reply
from tests.fixtures import (
    Listener,
    add_member,
    auth_settings,
    browser,
    compact,
    sign_in,
    sql_connection,
)
from tests.test_ai_validate import write_ai_test_db


@pytest.fixture(scope="module")
def ai_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return write_ai_test_db(tmp_path_factory.mktemp("aidb") / "ai.duckdb")


def _settings(clean_db: str, ai_db: Path, tmp_path: Path, **overrides: Any) -> Settings:
    return auth_settings(
        database_url=clean_db,
        duckdb_path=ai_db,
        query_spill_dir=tmp_path / f"spill-{uuid.uuid4().hex[:6]}",
        query_workers=1,
        **overrides,
    )


class Gate:
    """A model client that waits until released, then answers with valid SQL."""

    def __init__(self) -> None:
        self.entered = threading.Event()
        self.entries = threading.Semaphore(0)  # released once per call
        self.release = threading.Event()
        self.calls = 0

    async def complete(self, *, system: str, user: str, max_tokens: int) -> ModelReply:
        self.calls += 1
        self.entered.set()
        self.entries.release()
        await asyncio.to_thread(self.release.wait, 30)  # bounded: a broken test fails
        return sql_reply("SELECT count(*) AS n FROM trips", "Counts trips.")


@pytest.fixture
def model() -> ScriptedClient:
    return ScriptedClient([sql_reply("SELECT count(*) AS n FROM trips", "Counts trips.")])


def _app(clean_db: str, ai_db: Path, tmp_path: Path, client: Any, **overrides: Any) -> FastAPI:
    return create_app(_settings(clean_db, ai_db, tmp_path, **overrides), model_client=client)


@pytest.fixture
def client(
    clean_db: str, ai_db: Path, tmp_path: Path, model: ScriptedClient
) -> Iterator[TestClient]:
    with browser(_app(clean_db, ai_db, tmp_path, model)) as test_client:
        sign_in(test_client)
        yield test_client


@pytest.fixture
def listener(clean_db: str) -> Iterator[Listener]:
    listening = Listener(clean_db)
    yield listening
    listening.close()


def _notebook(client: TestClient) -> str:
    notebook_id: str = client.post("/notebooks", json={"title": "AI"}).json()["id"]
    return notebook_id


def _rows(url: str, query: str, *params: Any) -> list[tuple[Any, ...]]:
    with sql_connection(url) as conn:
        return conn.execute(query, params).fetchall()


def _ask(client: TestClient, notebook_id: str, body: dict[str, Any], cell: str = "c1") -> Any:
    return client.post(f"/notebooks/{notebook_id}/cells/{cell}/ai", json=body)


GENERATE = {"kind": "generate", "prompt": "How many trips?"}


# --- the happy path: suggestion, log, NOTIFY ---------------------------------------


def test_generate_stores_a_pending_suggestion_logs_the_request_and_notifies(
    client: TestClient, listener: Listener, clean_db: str
) -> None:
    notebook_id = _notebook(client)
    response = _ask(client, notebook_id, GENERATE)
    assert response.status_code == 200, response.text
    suggestion = response.json()
    assert suggestion["cell_id"] == "c1"
    assert suggestion["kind"] == "generate"
    assert suggestion["status"] == "pending"
    assert suggestion["sql"] == "SELECT count(*) AS n FROM trips"
    assert suggestion["explanation"] == "Counts trips."
    assert suggestion["base_sql"] is None
    assert suggestion["valid"] is True
    assert set(suggestion) == {
        "id", "cell_id", "kind", "status", "sql", "explanation", "base_sql", "valid", "created_at"
    }  # fmt: skip

    [(request_id, status, prompt, model, attempts, tokens_in, tokens_out, latency, error)] = _rows(
        clean_db,
        "SELECT id, status, prompt, model, attempts, input_tokens, output_tokens, latency_ms,"
        " error FROM ai_requests",
    )
    assert status == "succeeded"
    # The question, plus the settings it ran with (refusal fallbacks are only
    # ever on for Claude itself, not for a test or fake client).
    assert prompt == {"prompt": "How many trips?", "effort": "medium", "refusal_fallbacks": False}
    assert model == "claude-haiku-5-5"
    assert attempts == [
        {
            "sql": "SELECT count(*) AS n FROM trips",
            "error": None,
            "input_tokens": 100,
            "output_tokens": 10,
            "model": "scripted",
        }
    ]
    assert (tokens_in, tokens_out) == (100, 10)
    assert latency is not None and latency >= 0
    assert error is None
    [(suggestion_request,)] = _rows(clean_db, "SELECT request_id FROM ai_suggestions")
    assert suggestion_request == request_id

    assert listener.take(2) == [
        compact(events.ai_started(uuid.UUID(notebook_id), "c1", request_id, "generate", "Ada")),
        compact(
            events.ai_suggestion(
                uuid.UUID(notebook_id), "c1", request_id, uuid.UUID(suggestion["id"])
            )
        ),
    ]
    assert listener.nothing_more()


@pytest.mark.parametrize(
    "model",
    [ScriptedClient([sql_reply("SELECT nope FROM trips"), sql_reply("SELECT borough FROM trips")])],
)
def test_the_real_validator_drives_a_repair(client: TestClient, clean_db: str) -> None:
    response = _ask(client, _notebook(client), GENERATE)
    assert response.status_code == 200
    assert response.json()["sql"] == "SELECT borough FROM trips"
    assert response.json()["valid"] is True
    [(attempts,)] = _rows(clean_db, "SELECT attempts FROM ai_requests")
    assert [a["sql"] for a in attempts] == ["SELECT nope FROM trips", "SELECT borough FROM trips"]
    assert attempts[0]["error"].startswith("Binder Error")
    assert attempts[1]["error"] is None


@pytest.mark.parametrize("model", [ScriptedClient([sql_reply("SELECT nope FROM trips")])])
def test_a_query_that_never_validates_is_still_suggested_as_invalid(
    client: TestClient, clean_db: str
) -> None:
    response = _ask(client, _notebook(client), GENERATE)
    assert response.status_code == 200
    assert response.json()["valid"] is False
    assert "did not pass validation" in response.json()["explanation"]
    assert _rows(
        clean_db, "SELECT status, jsonb_array_length(attempts::jsonb) FROM ai_requests"
    ) == [("succeeded", 3)]


def test_fix_and_explain_keep_the_cell_sql_as_base(
    client: TestClient, model: ScriptedClient, clean_db: str
) -> None:
    notebook_id = _notebook(client)
    fixed = _ask(
        client, notebook_id, {"kind": "fix", "sql": "SELECT fare FROM trips", "error": "no fare"}
    )
    assert fixed.status_code == 200
    assert fixed.json()["base_sql"] == "SELECT fare FROM trips"
    assert fixed.json()["kind"] == "fix"

    model.script = [reply("It counts the trips.")]
    model.calls.clear()
    explained = _ask(
        client, notebook_id, {"kind": "explain", "sql": "SELECT count(*) FROM trips"}, cell="c2"
    )
    assert explained.status_code == 200
    body = explained.json()
    assert body["kind"] == "explain" and body["sql"] is None
    assert body["explanation"] == "It counts the trips."
    assert body["base_sql"] == "SELECT count(*) FROM trips"
    prompts = [
        row[0] for row in _rows(clean_db, "SELECT prompt FROM ai_requests ORDER BY created_at")
    ]
    settings = {"effort": "medium", "refusal_fallbacks": False}
    assert prompts == [
        {"sql": "SELECT fare FROM trips", "error": "no fare", **settings},
        {"sql": "SELECT count(*) FROM trips", **settings},
    ]


# --- failures --------------------------------------------------------------------


@pytest.mark.parametrize("model", [ScriptedClient([reply("", stop_reason="refusal")])])
def test_a_refusal_fails_the_request_and_notifies(
    client: TestClient, listener: Listener, clean_db: str
) -> None:
    notebook_id = _notebook(client)
    response = _ask(client, notebook_id, GENERATE)
    assert response.status_code == 502
    assert response.json()["detail"] == {"kind": "ai_failed", "message": pipeline.REFUSED}
    [(request_id, status, error, attempts)] = _rows(
        clean_db, "SELECT id, status, error, attempts FROM ai_requests"
    )
    assert (status, error) == ("failed", pipeline.REFUSED)
    assert len(attempts) == 1
    assert _rows(clean_db, "SELECT count(*) FROM ai_suggestions") == [(0,)]
    started, failed = listener.take_events(2)
    assert started["type"] == "ai_started"
    assert failed == events.ai_failed(uuid.UUID(notebook_id), "c1", request_id, pipeline.REFUSED)


@pytest.mark.parametrize(
    "model",
    [
        ScriptedClient(
            [sql_reply("SELECT nope FROM trips"), AssistantUnavailableError("AI is down.")]
        )
    ],
)
def test_a_model_api_failure_is_logged_with_the_attempts_so_far(
    client: TestClient, clean_db: str
) -> None:
    response = _ask(client, _notebook(client), GENERATE)
    assert response.status_code == 502
    assert response.json()["detail"]["message"] == "AI is down."
    [(status, error, attempts)] = _rows(clean_db, "SELECT status, error, attempts FROM ai_requests")
    assert (status, error) == ("failed", "AI is down.")
    assert [a["sql"] for a in attempts] == ["SELECT nope FROM trips"]


def test_without_a_key_the_assistant_is_unavailable(
    clean_db: str, ai_db: Path, tmp_path: Path
) -> None:
    with browser(_app(clean_db, ai_db, tmp_path, None)) as test_client:
        sign_in(test_client)
        response = _ask(test_client, _notebook(test_client), GENERATE)
    assert response.status_code == 503
    assert response.json()["detail"]["kind"] == "unavailable"


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "generate", "prompt": "x" * 2001},
        {"kind": "generate", "prompt": ""},
        {"kind": "fix", "sql": "SELECT 1"},
        {"kind": "fix", "sql": "SELECT 1", "error": "e" * 4001},
        {"kind": "explain", "sql": "x" * 20_001},
        {"kind": "rewrite", "sql": "SELECT 1"},
    ],
)
def test_request_bodies_are_validated_and_capped(
    client: TestClient, body: dict[str, Any], model: ScriptedClient
) -> None:
    response = _ask(client, _notebook(client), body)
    assert response.status_code == 422
    assert model.calls == []


def test_a_bad_cell_id_is_refused(client: TestClient) -> None:
    response = _ask(client, _notebook(client), GENERATE, cell="bad cell!")
    assert response.status_code == 422


# --- who may ask -----------------------------------------------------------------------


def test_viewers_cannot_ask_and_non_members_get_404(
    client: TestClient, clean_db: str, model: ScriptedClient
) -> None:
    notebook_id = _notebook(client)
    other = TestClient(client.app, base_url="http://localhost", headers=dict(client.headers))
    viewer = sign_in(other, "Viewer")
    assert _ask(other, notebook_id, GENERATE).status_code == 404  # not a member yet
    add_member(clean_db, notebook_id, viewer["id"], "viewer")
    response = _ask(other, notebook_id, GENERATE)
    assert response.status_code == 403
    assert model.calls == []


def test_signed_out_requests_are_refused(client: TestClient) -> None:
    notebook_id = _notebook(client)
    client.cookies.clear()
    assert _ask(client, notebook_id, GENERATE).status_code == 401


# --- one request per cell, rate limit ---------------------------------------------------


@pytest.mark.parametrize("model", [Gate()])
def test_a_second_request_for_a_busy_cell_is_refused(
    client: TestClient, model: Gate, clean_db: str, listener: Listener
) -> None:
    notebook_id = _notebook(client)
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(_ask, client, notebook_id, GENERATE)
        assert model.entered.wait(10)
        # ai_started is delivered only after its transaction committed, so
        # the 'running' row is visible to anyone who hears about it.
        assert listener.take_events(1)[0]["type"] == "ai_started"
        assert _rows(clean_db, "SELECT status FROM ai_requests") == [("running",)]

        busy = _ask(client, notebook_id, GENERATE)
        assert busy.status_code == 409
        assert busy.json()["detail"] == {"kind": "busy", "message": CELL_BUSY}
        model.release.set()
        assert first.result(30).status_code == 200
    assert model.calls == 1
    assert _ask(client, notebook_id, GENERATE).status_code == 200  # free again
    assert model.calls == 2


def test_a_new_request_supersedes_a_pending_suggestion(
    client: TestClient, listener: Listener, clean_db: str
) -> None:
    notebook_id = _notebook(client)
    old = _ask(client, notebook_id, GENERATE).json()
    # Pretend the document never showed it (the sync server missed the
    # NOTIFY): nothing here depends on the document.
    listener.take(2)

    new = _ask(client, notebook_id, GENERATE)
    assert new.status_code == 200
    assert _rows(
        clean_db,
        "SELECT status, decided_by, decided_at IS NOT NULL FROM ai_suggestions WHERE id = %s",
        uuid.UUID(old["id"]),
    ) == [("rejected", None, True)]
    assert _rows(
        clean_db, "SELECT status FROM ai_suggestions WHERE id = %s", uuid.UUID(new.json()["id"])
    ) == [("pending",)]

    # The old suggestion is resolved before the new request starts.
    resolved, started, suggested = listener.take_events(3)
    assert resolved == events.ai_resolved(
        uuid.UUID(notebook_id), "c1", uuid.UUID(old["id"]), "rejected"
    )
    assert started["type"] == "ai_started"
    assert suggested["type"] == "ai_suggestion"
    assert listener.nothing_more()

    [(prompt,)] = _rows(
        clean_db, "SELECT prompt FROM ai_requests WHERE id = %s", uuid.UUID(started["request_id"])
    )
    assert prompt["superseded"] == [old["id"]]
    first_prompt = _rows(clean_db, "SELECT prompt FROM ai_requests ORDER BY created_at")[0][0]
    assert "superseded" not in first_prompt

    # It can't be decided any more.
    late = _decide(client, notebook_id, old["id"], "accepted")
    assert late.status_code == 409
    assert late.json()["detail"]["kind"] == "decided"


def test_a_busy_cell_keeps_its_pending_suggestion(client: TestClient, clean_db: str) -> None:
    notebook_id = _notebook(client)
    old = _ask(client, notebook_id, GENERATE).json()
    with sql_connection(clean_db) as conn:  # another request in flight on the cell
        conn.execute(
            "INSERT INTO ai_requests (id, notebook_id, cell_id, kind, prompt, model, status,"
            " attempts, input_tokens, output_tokens) VALUES (%s, %s, 'c1', 'generate', '{}',"
            " 'm', 'running', '[]', 0, 0)",
            (uuid.uuid4(), notebook_id),
        )
    assert _ask(client, notebook_id, GENERATE).status_code == 409
    assert _rows(
        clean_db, "SELECT status FROM ai_suggestions WHERE id = %s", uuid.UUID(old["id"])
    ) == [("pending",)]


@pytest.mark.parametrize("model", [Gate()])
def test_one_person_runs_at_most_two_requests_at_once(
    client: TestClient, model: Gate, clean_db: str
) -> None:
    notebook_id = _notebook(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(_ask, client, notebook_id, GENERATE, "c1")
        second = pool.submit(_ask, client, notebook_id, GENERATE, "c2")
        assert model.entries.acquire(timeout=10) and model.entries.acquire(timeout=10)
        third = _ask(client, notebook_id, GENERATE, "c3")
        assert third.status_code == 429
        assert third.json()["detail"]["kind"] == "rate_limited"
        model.release.set()
        assert first.result(30).status_code == 200
        assert second.result(30).status_code == 200
    # The refused request ran nothing and logged nothing, and the counts are
    # released once requests finish.
    assert model.calls == 2
    assert _rows(clean_db, "SELECT count(*) FROM ai_requests") == [(2,)]
    assert _ask(client, notebook_id, GENERATE, "c3").status_code == 200


@pytest.mark.parametrize("model", [Gate()])
def test_past_the_process_wide_cap_requests_are_refused_as_busy(
    clean_db: str, ai_db: Path, tmp_path: Path, model: Gate
) -> None:
    app = _app(clean_db, ai_db, tmp_path, model, ai_max_concurrent=1)
    with browser(app) as test_client, ThreadPoolExecutor(max_workers=1) as pool:
        sign_in(test_client)
        notebook_id = _notebook(test_client)
        first = pool.submit(_ask, test_client, notebook_id, GENERATE, "c1")
        assert model.entered.wait(10)
        refused = _ask(test_client, notebook_id, GENERATE, "c2")
        assert refused.status_code == 503
        assert refused.json()["detail"]["kind"] == "busy"
        model.release.set()
        assert first.result(30).status_code == 200
        assert _ask(test_client, notebook_id, GENERATE, "c2").status_code == 200


@pytest.mark.parametrize("model", [Gate()])
def test_other_cells_are_not_blocked(client: TestClient, model: Gate) -> None:
    notebook_id = _notebook(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(_ask, client, notebook_id, GENERATE, "c1")
        assert model.entered.wait(10)
        second = pool.submit(_ask, client, notebook_id, GENERATE, "c2")
        model.release.set()
        assert first.result(30).status_code == 200
        assert second.result(30).status_code == 200


def test_requests_past_the_per_user_limit_are_refused(
    client: TestClient, model: ScriptedClient
) -> None:
    ai: AiService = client.app.state.ai  # type: ignore[attr-defined]
    ai.rate_limiter = RateLimiter(limit=2, window_seconds=60)
    notebook_id = _notebook(client)
    assert _ask(client, notebook_id, GENERATE, "c1").status_code == 200
    assert _ask(client, notebook_id, GENERATE, "c2").status_code == 200
    limited = _ask(client, notebook_id, GENERATE, "c3")
    assert limited.status_code == 429
    assert limited.json()["detail"]["kind"] == "rate_limited"
    assert len(model.calls) == 2


def test_the_rate_limiter_slides_and_refunds() -> None:
    now = [0.0]
    limiter = RateLimiter(limit=2, window_seconds=10, clock=lambda: now[0])
    user = uuid.uuid4()
    assert limiter.try_acquire(user) and limiter.try_acquire(user)
    assert not limiter.try_acquire(user)
    assert limiter.try_acquire(uuid.uuid4())  # per user
    limiter.refund(user)
    assert limiter.try_acquire(user)
    now[0] = 10.5
    assert limiter.try_acquire(user) and limiter.try_acquire(user)
    assert not limiter.try_acquire(user)


# --- abandoned requests -----------------------------------------------------------------


def test_an_abandoned_running_request_does_not_block_the_cell_forever(
    client: TestClient, clean_db: str, listener: Listener
) -> None:
    notebook_id = _notebook(client)
    stale_id = uuid.uuid4()
    with sql_connection(clean_db) as conn:
        conn.execute(
            "INSERT INTO ai_requests (id, notebook_id, cell_id, kind, prompt, model, status,"
            " attempts, input_tokens, output_tokens, created_at)"
            " VALUES (%s, %s, 'c1', 'generate', '{}', 'm', 'running', '[]', 0, 0,"
            " now() - interval '10 minutes')",
            (stale_id, notebook_id),
        )
    assert _ask(client, notebook_id, GENERATE).status_code == 200
    assert _rows(clean_db, "SELECT status, error FROM ai_requests WHERE id = %s", stale_id) == [
        ("failed", ABANDONED)
    ]
    kinds = [(e["type"], e["request_id"]) for e in listener.take_events(3)]
    assert kinds[0] == ("ai_failed", str(stale_id))
    assert [kind for kind, _ in kinds[1:]] == ["ai_started", "ai_suggestion"]


# --- decisions -------------------------------------------------------------------------


def _decide(client: TestClient, notebook_id: str, suggestion_id: str, decision: str) -> Any:
    return client.post(
        f"/notebooks/{notebook_id}/ai/suggestions/{suggestion_id}/decision",
        json={"decision": decision},
    )


@pytest.mark.parametrize("decision", ["accepted", "rejected"])
def test_a_pending_suggestion_is_decided_once(
    client: TestClient, listener: Listener, clean_db: str, decision: str
) -> None:
    notebook_id = _notebook(client)
    suggestion = _ask(client, notebook_id, GENERATE).json()
    listener.take(2)
    response = _decide(client, notebook_id, suggestion["id"], decision)
    assert response.status_code == 200
    assert response.json() == {**suggestion, "status": decision}
    [(status, decided_by, decided_at)] = _rows(
        clean_db, "SELECT status, decided_by, decided_at FROM ai_suggestions"
    )
    assert status == decision and decided_by is not None and decided_at is not None
    assert listener.take(1) == [
        compact(
            events.ai_resolved(uuid.UUID(notebook_id), "c1", uuid.UUID(suggestion["id"]), decision)
        )
    ]
    again = _decide(client, notebook_id, suggestion["id"], "rejected")
    assert again.status_code == 409
    assert again.json()["detail"]["kind"] == "decided"
    assert listener.nothing_more()


def test_deciding_an_unknown_or_foreign_suggestion_is_404(client: TestClient) -> None:
    notebook_id = _notebook(client)
    other_notebook = _notebook(client)
    suggestion = _ask(client, notebook_id, GENERATE).json()
    assert _decide(client, notebook_id, str(uuid.uuid4()), "accepted").status_code == 404
    assert _decide(client, other_notebook, suggestion["id"], "accepted").status_code == 404
    assert _decide(client, notebook_id, suggestion["id"], "maybe").status_code == 422


def test_viewers_cannot_decide(client: TestClient, clean_db: str) -> None:
    notebook_id = _notebook(client)
    suggestion = _ask(client, notebook_id, GENERATE).json()
    other = TestClient(client.app, base_url="http://localhost", headers=dict(client.headers))
    viewer = sign_in(other, "Viewer")
    add_member(clean_db, notebook_id, viewer["id"], "viewer")
    assert _decide(other, notebook_id, suggestion["id"], "accepted").status_code == 403
    add_member(clean_db, _notebook(client), viewer["id"], "editor")  # elsewhere: irrelevant
    assert _decide(other, notebook_id, suggestion["id"], "accepted").status_code == 403


# --- the fake model (AI_FAKE_MODEL), end to end -------------------------------------------


def test_the_fake_model_answers_through_the_real_pipeline(
    clean_db: str, ai_db: Path, tmp_path: Path
) -> None:
    app = _app(clean_db, ai_db, tmp_path, None, ai_fake_model=True)
    with browser(app) as test_client:
        sign_in(test_client)
        notebook_id = _notebook(test_client)
        ok = _ask(test_client, notebook_id, GENERATE, "c1")
        assert ok.status_code == 200 and ok.json()["sql"] == FAKE_VALID_SQL
        assert ok.json()["valid"] is True
        repaired = _ask(
            test_client, notebook_id, {"kind": "generate", "prompt": "fake-repair"}, "c2"
        )
        assert repaired.json()["valid"] is True
        invalid = _ask(
            test_client, notebook_id, {"kind": "generate", "prompt": "fake-invalid"}, "c3"
        )
        assert invalid.json()["valid"] is False
        refused = _ask(
            test_client, notebook_id, {"kind": "generate", "prompt": "fake-refuse"}, "c4"
        )
        assert refused.status_code == 502
    models = {row[0] for row in _rows(clean_db, "SELECT model FROM ai_requests")}
    assert models == {FAKE_MODEL_NAME}
    attempts = _rows(clean_db, "SELECT attempts FROM ai_requests ORDER BY created_at")
    assert [len(row[0]) for row in attempts] == [1, 2, 3, 1]


# --- the service on its own: disconnects and shutdown -------------------------------------


class _Schema:
    async def get(self) -> SchemaContext:
        return SchemaContext(dialect="duckdb", text="Table trips")


@pytest.fixture
async def service_parts(clean_db: str) -> AsyncIterator[tuple[Any, str, uuid.UUID]]:
    engine = create_engine(clean_db)
    sessions = make_sessionmaker(engine)
    user_id, notebook_id = uuid.uuid4(), uuid.uuid4()
    with sql_connection(clean_db) as conn:
        conn.execute("INSERT INTO users (id, name) VALUES (%s, 'Ada')", (user_id,))
        conn.execute("INSERT INTO notebooks (id, title) VALUES (%s, 'n')", (notebook_id,))
    yield sessions, str(notebook_id), user_id
    await engine.dispose()


class _AsyncGate:
    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def complete(self, *, system: str, user: str, max_tokens: int) -> ModelReply:
        self.entered.set()
        await self.release.wait()
        return sql_reply("SELECT 1")


@pytest.mark.anyio
async def test_a_request_whose_caller_disconnects_still_finishes(
    service_parts: tuple[Any, str, uuid.UUID], clean_db: str
) -> None:
    sessions, notebook_id, user_id = service_parts
    gate = _AsyncGate()
    service = AiService(sessions, gate, "m", _Schema(), TableValidator())
    caller = asyncio.create_task(
        service.request(
            uuid.UUID(notebook_id), "c1", user_id, "Ada", AiTask(kind="generate", prompt="q")
        )
    )
    await asyncio.wait_for(gate.entered.wait(), 10)
    caller.cancel()  # the HTTP request goes away
    await asyncio.gather(caller, return_exceptions=True)
    gate.release.set()
    for _ in range(100):
        if _rows(clean_db, "SELECT status FROM ai_requests") == [("succeeded",)]:
            break
        await asyncio.sleep(0.05)
    assert _rows(clean_db, "SELECT status FROM ai_requests") == [("succeeded",)]
    assert _rows(clean_db, "SELECT status FROM ai_suggestions") == [("pending",)]
    await service.close()


@pytest.mark.anyio
async def test_shutdown_marks_a_request_in_flight_failed(
    service_parts: tuple[Any, str, uuid.UUID], clean_db: str
) -> None:
    sessions, notebook_id, user_id = service_parts
    gate = _AsyncGate()
    service = AiService(sessions, gate, "m", _Schema(), TableValidator())
    listener = Listener(clean_db)
    try:
        caller = asyncio.create_task(
            service.request(
                uuid.UUID(notebook_id), "c1", user_id, "Ada", AiTask(kind="generate", prompt="q")
            )
        )
        await asyncio.wait_for(gate.entered.wait(), 10)
        await service.close()
        outcome = await caller
        assert not isinstance(outcome, Done)
        assert _rows(clean_db, "SELECT status, error FROM ai_requests") == [("failed", STOPPED)]
        kinds = [event["type"] for event in await asyncio.to_thread(listener.take_events, 2)]
        assert kinds == ["ai_started", "ai_failed"]
    finally:
        listener.close()


@pytest.mark.anyio
async def test_a_request_past_its_deadline_fails(
    service_parts: tuple[Any, str, uuid.UUID], clean_db: str
) -> None:
    sessions, notebook_id, user_id = service_parts
    service = AiService(
        sessions, _AsyncGate(), "m", _Schema(), TableValidator(), deadline_seconds=0.2
    )
    outcome = await service.request(
        uuid.UUID(notebook_id), "c1", user_id, "Ada", AiTask(kind="explain", sql="SELECT 1")
    )
    assert not isinstance(outcome, Done)
    [(status, error, latency)] = _rows(
        clean_db, "SELECT status, error, latency_ms FROM ai_requests"
    )
    assert status == "failed" and "too long" in error and latency >= 200
    await service.close()


class _AnswersOnceThenHangs:
    """Answers the first call with SQL that fails validation; the repair call never returns."""

    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, *, system: str, user: str, max_tokens: int) -> ModelReply:
        self.calls += 1
        if self.calls == 1:
            return sql_reply("SELECT nope FROM t")
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


@pytest.mark.anyio
async def test_a_request_past_its_deadline_logs_the_replies_it_already_paid_for(
    service_parts: tuple[Any, str, uuid.UUID], clean_db: str
) -> None:
    sessions, notebook_id, user_id = service_parts
    client = _AnswersOnceThenHangs()
    validator = TableValidator(errors={"nope": "Unknown column nope"})
    service = AiService(sessions, client, "m", _Schema(), validator, deadline_seconds=0.2)
    outcome = await service.request(
        uuid.UUID(notebook_id), "c1", user_id, "Ada", AiTask(kind="generate", prompt="q")
    )
    assert not isinstance(outcome, Done)
    assert client.calls == 2  # the deadline hit during the repair call
    [(status, attempts, input_tokens, output_tokens)] = _rows(
        clean_db, "SELECT status, attempts, input_tokens, output_tokens FROM ai_requests"
    )
    assert status == "failed"
    # The completed attempt as it was: its SQL and why it failed validation.
    [attempt] = attempts
    assert attempt["sql"] == "SELECT nope FROM t"
    assert attempt["error"] == "Unknown column nope"
    assert attempt["model"] == "scripted"
    assert (input_tokens, output_tokens) == (100, 10)
    await service.close()


class _HangingValidator:
    async def validate(self, sql: str) -> str | None:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


@pytest.mark.anyio
async def test_a_reply_whose_validation_the_deadline_stopped_is_still_logged(
    service_parts: tuple[Any, str, uuid.UUID], clean_db: str
) -> None:
    sessions, notebook_id, user_id = service_parts
    client = ScriptedClient([sql_reply("SELECT 1")])
    service = AiService(sessions, client, "m", _Schema(), _HangingValidator(), deadline_seconds=0.2)
    await service.request(
        uuid.UUID(notebook_id), "c1", user_id, "Ada", AiTask(kind="generate", prompt="q")
    )
    [(attempts, input_tokens)] = _rows(clean_db, "SELECT attempts, input_tokens FROM ai_requests")
    [attempt] = attempts
    assert attempt["sql"] is None and "too long" in attempt["error"]
    assert input_tokens == 100  # the reply arrived, so it was paid for
    await service.close()


@pytest.mark.anyio
async def test_a_cancellation_right_after_the_claim_still_fails_the_row(
    service_parts: tuple[Any, str, uuid.UUID], clean_db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    sessions, notebook_id, user_id = service_parts
    real_claim = AiService._claim

    async def claim_then_cancel(self: AiService, *args: Any) -> Any:
        await real_claim(self, *args)  # committed: the row is 'running'
        raise asyncio.CancelledError  # e.g. shutdown, before the work starts

    monkeypatch.setattr(AiService, "_claim", claim_then_cancel)
    service = AiService(sessions, _AsyncGate(), "m", _Schema(), TableValidator())
    listener = Listener(clean_db)
    try:
        outcome = await service.request(
            uuid.UUID(notebook_id), "c1", user_id, "Ada", AiTask(kind="generate", prompt="q")
        )
        assert outcome == Failed(STOPPED)
        assert _rows(clean_db, "SELECT status, error FROM ai_requests") == [("failed", STOPPED)]
        kinds = [event["type"] for event in await asyncio.to_thread(listener.take_events, 2)]
        assert kinds == ["ai_started", "ai_failed"]
    finally:
        listener.close()
    await service.close()


@pytest.mark.anyio
async def test_in_flight_counts_are_released_when_work_ends(
    service_parts: tuple[Any, str, uuid.UUID], clean_db: str
) -> None:
    sessions, notebook_id, user_id = service_parts
    gate = _AsyncGate()
    service = AiService(sessions, gate, "m", _Schema(), TableValidator(), max_per_user=1)
    first = asyncio.create_task(
        service.request(uuid.UUID(notebook_id), "c1", user_id, "Ada", AiTask("explain", sql="x"))
    )
    await asyncio.wait_for(gate.entered.wait(), 10)
    second = await service.request(
        uuid.UUID(notebook_id), "c2", user_id, "Ada", AiTask("explain", sql="x")
    )
    assert isinstance(second, UserBusy)
    # Someone else isn't held back by this person's requests.
    grace = uuid.uuid4()
    with sql_connection(clean_db) as conn:
        conn.execute("INSERT INTO users (id, name) VALUES (%s, 'Grace')", (grace,))
    theirs = asyncio.create_task(
        service.request(uuid.UUID(notebook_id), "c3", grace, "Grace", AiTask("explain", sql="x"))
    )
    gate.release.set()
    assert isinstance(await theirs, Done)
    assert isinstance(await first, Done)
    third = await service.request(
        uuid.UUID(notebook_id), "c2", user_id, "Ada", AiTask("explain", sql="x")
    )
    assert isinstance(third, Done)
    await service.close()


def test_payloads_stay_small() -> None:
    long_message = "x" * 5000
    event = events.ai_failed(uuid.uuid4(), "c" * 64, uuid.uuid4(), long_message)
    assert len(event["message"]) == events.AI_FAILED_MESSAGE_MAX_CHARS
    assert len(events.encode(event)) < 1000
    started = events.ai_started(uuid.uuid4(), "c" * 64, uuid.uuid4(), "generate", "n" * 200)
    assert json.loads(events.encode(started))["user_name"] == "n" * 200
