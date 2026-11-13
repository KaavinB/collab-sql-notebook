"""The per-cell execution lock: one execution per cell, joined by later Run presses."""

import asyncio
import threading
import uuid
from collections.abc import AsyncIterator, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from notebook_api import events
from notebook_api.config import Settings
from notebook_api.db.session import create_engine, make_sessionmaker
from notebook_api.main import create_app
from notebook_api.notebooks.executions import (
    Executions,
    Failed,
    Stored,
    lock_ttl_seconds,
)
from notebook_api.query.engine import QueryResult
from notebook_api.query.runner import QueryFailedError
from tests.fixtures import Listener, auth_settings, browser, compact, sign_in, sql_connection


def _settings(clean_db: str, query_db: Path, tmp_path: Path) -> Settings:
    return auth_settings(
        database_url=clean_db,
        duckdb_path=query_db,
        query_spill_dir=tmp_path / f"spill-{uuid.uuid4().hex[:6]}",
        query_workers=2,
    )


@pytest.fixture
def client(clean_db: str, query_db: Path, tmp_path: Path) -> Iterator[TestClient]:
    with browser(create_app(_settings(clean_db, query_db, tmp_path))) as test_client:
        sign_in(test_client)
        yield test_client


@pytest.fixture
def listener(clean_db: str) -> Iterator[Listener]:
    listening = Listener(clean_db)
    yield listening
    listening.close()


def _notebook(client: TestClient) -> str:
    notebook_id: str = client.post("/notebooks", json={"title": "Locks"}).json()["id"]
    return notebook_id


def _scalar(url: str, query: str, *params: Any) -> Any:
    with sql_connection(url) as conn:
        row = conn.execute(query, params).fetchone()
    return None if row is None else row[0]


class Gate:
    """Makes SQL "slow" wait inside the runner until released, and counts runner calls.

    The runner is patched on the instance, so Executions (which holds that
    instance) sees the patched method.
    """

    def __init__(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()
        self.calls = 0
        self.fail_with: QueryFailedError | None = None
        runner = client.app.state.query_runner  # type: ignore[attr-defined]
        real_run = runner.run

        async def run(sql: str) -> Any:
            self.calls += 1
            if sql != "slow":
                return await real_run(sql)
            self.entered.set()
            # Bounded, so a broken test fails instead of hanging.
            await asyncio.to_thread(self.release.wait, 30)
            if self.fail_with is not None:
                raise self.fail_with
            return await real_run("select 'slow' as x")

        monkeypatch.setattr(runner, "run", run)


@pytest.fixture
def joins(monkeypatch: pytest.MonkeyPatch) -> threading.Semaphore:
    """Released once each time a request starts waiting for another's execution."""
    joined = threading.Semaphore(0)
    real_join = Executions._join

    async def join(self: Executions, *args: Any) -> Any:
        joined.release()
        return await real_join(self, *args)

    monkeypatch.setattr(Executions, "_join", join)
    return joined


def _post(pool: ThreadPoolExecutor, client: TestClient, url: str, sql: str) -> Future[Any]:
    return pool.submit(lambda: client.post(url, json={"sql": sql}))


# --- one execution per cell ----------------------------------------------------------


def test_two_runs_of_one_cell_become_one_execution(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    joins: threading.Semaphore,
    listener: Listener,
    clean_db: str,
) -> None:
    gate = Gate(client, monkeypatch)
    notebook_id = _notebook(client)
    url = f"/notebooks/{notebook_id}/cells/c1/runs"
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = _post(pool, client, url, "slow")
        assert gate.entered.wait(10)
        # Different SQL: the second press joins anyway and gets the first's run.
        second = _post(pool, client, url, "select 'edited' as x")
        assert joins.acquire(timeout=10)
        gate.release.set()
        responses = [first.result(30), second.result(30)]

    assert gate.calls == 1  # the query ran once
    assert sorted(r.status_code for r in responses) == [200, 201]
    assert responses[0].json() == responses[1].json()
    run = responses[0].json()
    assert run["sql"] == "slow"
    assert run["result"]["rows"] == [["slow"]]
    assert _scalar(clean_db, "SELECT count(*) FROM cell_runs") == 1
    assert _scalar(clean_db, "SELECT count(*) FROM cell_executions") == 0
    kinds = [event["type"] for event in listener.take_events(2)]
    assert kinds == ["run_started", "run_finished"]
    assert listener.nothing_more()


def test_runs_of_different_cells_proceed_in_parallel(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    gate = Gate(client, monkeypatch)
    notebook_id = _notebook(client)
    with ThreadPoolExecutor(max_workers=1) as pool:
        slow = _post(pool, client, f"/notebooks/{notebook_id}/cells/c1/runs", "slow")
        assert gate.entered.wait(10)
        # c2 completes while c1 is still running.
        other = client.post(f"/notebooks/{notebook_id}/cells/c2/runs", json={"sql": "select 2"})
        assert other.status_code == 201
        assert not slow.done()
        gate.release.set()
        assert slow.result(30).status_code == 201
    assert gate.calls == 2


def test_a_run_after_the_previous_one_finished_runs_again(client: TestClient) -> None:
    notebook_id = _notebook(client)
    url = f"/notebooks/{notebook_id}/cells/c1/runs"
    first = client.post(url, json={"sql": "select 1 as x"})
    second = client.post(url, json={"sql": "select 2 as x"})
    assert (first.status_code, second.status_code) == (201, 201)
    assert second.json()["result"]["rows"] == [[2]]


def test_the_lock_lifetime_covers_the_longest_healthy_execution(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, clean_db: str
) -> None:
    # queue timeout + query timeout + the runner's 2 s kill grace + 10 s margin.
    assert lock_ttl_seconds(Settings()) == 5.0 + 10.0 + 2.0 + 10.0
    gate = Gate(client, monkeypatch)
    notebook_id = _notebook(client)
    with ThreadPoolExecutor(max_workers=1) as pool:
        slow = _post(pool, client, f"/notebooks/{notebook_id}/cells/c1/runs", "slow")
        assert gate.entered.wait(10)
        held = _scalar(
            clean_db,
            "SELECT extract(epoch FROM expires_at - started_at) FROM cell_executions",
        )
        gate.release.set()
        slow.result(30)
    settings: Settings = client.app.state.settings  # type: ignore[attr-defined]
    assert float(held) == pytest.approx(lock_ttl_seconds(settings))


# --- stale and foreign locks ----------------------------------------------------------


def _plant_lock(url: str, notebook_id: str, expires_in: str) -> str:
    execution_id = str(uuid.uuid4())
    with sql_connection(url) as conn:
        conn.execute(
            "INSERT INTO cell_executions (notebook_id, cell_id, execution_id, started_at, "
            f"expires_at) VALUES (%s, 'c1', %s, now(), now() + interval '{expires_in}')",
            (notebook_id, execution_id),
        )
    return execution_id


def test_an_expired_lock_is_taken_over(
    client: TestClient, listener: Listener, clean_db: str
) -> None:
    # Left behind by an API process that crashed mid-run.
    notebook_id = _notebook(client)
    stale = _plant_lock(clean_db, notebook_id, "-1 second")
    response = client.post(f"/notebooks/{notebook_id}/cells/c1/runs", json={"sql": "select 1"})
    assert response.status_code == 201
    started, finished = listener.take_events(2)
    assert started["type"] == "run_started"
    assert started["execution_id"] != stale
    assert finished["execution_id"] == started["execution_id"]
    assert finished["run_id"] == response.json()["id"]
    assert _scalar(clean_db, "SELECT count(*) FROM cell_executions") == 0


def test_a_live_lock_whose_execution_never_finishes_is_waited_for_until_it_expires(
    client: TestClient, clean_db: str
) -> None:
    # Held by another API process that then died: nothing will ever finish it.
    notebook_id = _notebook(client)
    _plant_lock(clean_db, notebook_id, "1 second")
    response = client.post(f"/notebooks/{notebook_id}/cells/c1/runs", json={"sql": "select 1"})
    assert response.status_code == 503
    assert response.json()["detail"] == {
        "kind": "busy",
        "message": "The run you joined didn't finish. Run the cell again.",
    }
    # Now that it has expired, the next press takes it over.
    retry = client.post(f"/notebooks/{notebook_id}/cells/c1/runs", json={"sql": "select 1"})
    assert retry.status_code == 201


def test_a_run_in_another_api_process_is_joined_through_postgres(
    clean_db: str, query_db: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with (
        browser(create_app(_settings(clean_db, query_db, tmp_path))) as first,
        browser(create_app(_settings(clean_db, query_db, tmp_path))) as second,
    ):
        sign_in(first, "Ada")
        sign_in(second, "Ed")
        notebook_id = _notebook(first)
        link = first.post(f"/notebooks/{notebook_id}/share-links", json={"role": "editor"})
        second.post("/share-links/accept", json={"token": link.json()["token"]})
        gate = Gate(first, monkeypatch)
        other_gate = Gate(second, monkeypatch)
        url = f"/notebooks/{notebook_id}/cells/c1/runs"
        with ThreadPoolExecutor(max_workers=2) as pool:
            slow = _post(pool, first, url, "slow")
            assert gate.entered.wait(10)
            joined = _post(pool, second, url, "select 1")
            # The second process has no task to wait on; it polls.
            threading.Event().wait(0.5)
            assert not joined.done()
            gate.release.set()
            responses = [slow.result(30), joined.result(30)]
    assert [r.status_code for r in responses] == [201, 200]
    assert responses[0].json() == responses[1].json()
    assert other_gate.calls == 0


# --- failures --------------------------------------------------------------------------


def test_a_service_failure_reaches_everyone_who_joined(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    joins: threading.Semaphore,
    listener: Listener,
    clean_db: str,
) -> None:
    gate = Gate(client, monkeypatch)
    gate.fail_with = QueryFailedError("crashed", "The query engine stopped unexpectedly.")
    notebook_id = _notebook(client)
    url = f"/notebooks/{notebook_id}/cells/c1/runs"
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = _post(pool, client, url, "slow")
        assert gate.entered.wait(10)
        second = _post(pool, client, url, "slow")
        assert joins.acquire(timeout=10)
        gate.release.set()
        responses = [first.result(30), second.result(30)]

    for response in responses:
        assert response.status_code == 503
        assert response.json()["detail"] == {
            "kind": "crashed",
            "message": "The query engine stopped unexpectedly.",
        }
    assert gate.calls == 1
    started, finished = listener.take_events(2)
    assert finished == events.run_finished(
        uuid.UUID(notebook_id), "c1", uuid.UUID(started["execution_id"]), None
    )
    assert _scalar(clean_db, "SELECT count(*) FROM cell_runs") == 0
    assert _scalar(clean_db, "SELECT count(*) FROM cell_executions") == 0


def test_deleting_the_notebook_mid_run_answers_404_and_leaves_no_lock(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    joins: threading.Semaphore,
    clean_db: str,
) -> None:
    gate = Gate(client, monkeypatch)
    notebook_id = _notebook(client)
    url = f"/notebooks/{notebook_id}/cells/c1/runs"
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = _post(pool, client, url, "slow")
        assert gate.entered.wait(10)
        second = _post(pool, client, url, "slow")
        assert joins.acquire(timeout=10)
        assert client.delete(f"/notebooks/{notebook_id}").status_code == 204
        gate.release.set()
        responses = [first.result(30), second.result(30)]
    assert [r.status_code for r in responses] == [404, 404]
    assert _scalar(clean_db, "SELECT count(*) FROM cell_executions") == 0
    assert _scalar(clean_db, "SELECT count(*) FROM cell_runs") == 0


# --- notifications ---------------------------------------------------------------------


def test_run_notifications_are_exact_ordered_and_sent_on_commit(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, listener: Listener, clean_db: str
) -> None:
    gate = Gate(client, monkeypatch)
    notebook_id = _notebook(client)
    with ThreadPoolExecutor(max_workers=1) as pool:
        slow = _post(pool, client, f"/notebooks/{notebook_id}/cells/c1/runs", "slow")
        assert gate.entered.wait(10)
        (started,) = listener.take(1)
        # Delivered means committed: the lock row is visible to anyone.
        with sql_connection(clean_db) as conn:
            row = conn.execute("SELECT execution_id, started_at FROM cell_executions").fetchone()
        assert row is not None
        execution_id, started_at = row
        assert started == compact(
            events.run_started(uuid.UUID(notebook_id), "c1", execution_id, "Ada", started_at)
        )
        assert '"started_at":"' + started_at.isoformat() + '"' in started
        assert listener.nothing_more()  # nothing finishes while the query runs
        gate.release.set()
        run = slow.result(30).json()

    (finished,) = listener.take(1)
    assert finished == compact(
        events.run_finished(uuid.UUID(notebook_id), "c1", execution_id, uuid.UUID(run["id"]))
    )
    assert _scalar(clean_db, "SELECT execution_id FROM cell_runs") == execution_id


def test_payloads_are_compact_and_bounded() -> None:
    # The largest a real message gets: a 64-character cell ID and a
    # 200-character name of characters that JSON escapes as \uXXXX.
    now = datetime.now(UTC)
    event = events.run_started(uuid.uuid4(), "c" * 64, uuid.uuid4(), "é" * 200, now)
    payload = events.encode(event)
    assert " " not in payload
    assert payload.isascii()
    assert len(payload.encode()) < events.MAX_PAYLOAD_BYTES
    with pytest.raises(ValueError, match="too large"):
        events.encode({"type": "x", "padding": "x" * events.MAX_PAYLOAD_BYTES})


# --- the execution outlives its request ---------------------------------------------------

RESULT: QueryResult = {
    "columns": [{"name": "x", "type": "INTEGER"}],
    "rows": [[1]],
    "row_count": 1,
    "truncated": False,
    "duration_ms": 1.0,
}


class FakeRunner:
    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = 0
        self.error: Exception | None = None

    async def run(self, sql: str) -> QueryResult:
        self.calls += 1
        self.entered.set()
        await self.release.wait()
        if self.error is not None:
            raise self.error
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


async def _until(condition: Any) -> None:
    """Poll a database condition (there's no event to wait on in another connection)."""
    async with asyncio.timeout(10):
        while True:
            if await asyncio.to_thread(condition):
                return
            await asyncio.sleep(0.05)


@pytest.mark.anyio
async def test_a_cancelled_request_does_not_cancel_its_execution(
    sessions: async_sessionmaker[AsyncSession], clean_db: str
) -> None:
    # The person who pressed Run closed the page mid-run. Others may be
    # waiting for the result, so the execution finishes, stores its run and
    # releases the lock.
    notebook_id, user_id = _seed(clean_db)
    runner = FakeRunner()
    executions = Executions(sessions, runner, lock_ttl_seconds=30)
    listener = Listener(clean_db)
    try:
        request = asyncio.create_task(executions.run(notebook_id, "c1", "select 1", user_id, "Ada"))
        await runner.entered.wait()
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert _scalar(clean_db, "SELECT count(*) FROM cell_executions") == 1
        runner.release.set()
        await _until(lambda: _scalar(clean_db, "SELECT count(*) FROM cell_executions") == 0)
        assert _scalar(clean_db, "SELECT count(*) FROM cell_runs") == 1
        kinds = [e["type"] for e in await asyncio.to_thread(listener.take_events, 2)]
        assert kinds == ["run_started", "run_finished"]
    finally:
        listener.close()
        await executions.close()


@pytest.mark.anyio
async def test_stopping_an_execution_releases_its_lock(
    sessions: async_sessionmaker[AsyncSession], clean_db: str
) -> None:
    # At shutdown the execution itself is cancelled mid-query.
    notebook_id, user_id = _seed(clean_db)
    runner = FakeRunner()
    executions = Executions(sessions, runner, lock_ttl_seconds=30)
    listener = Listener(clean_db)
    try:
        request = asyncio.create_task(executions.run(notebook_id, "c1", "select 1", user_id, "Ada"))
        await runner.entered.wait()
        await executions.close()
        outcome, joined = await request
        assert isinstance(outcome, Failed) and outcome.kind == "unavailable"
        assert not joined
        assert _scalar(clean_db, "SELECT count(*) FROM cell_executions") == 0
        assert _scalar(clean_db, "SELECT count(*) FROM cell_runs") == 0
        started, finished = await asyncio.to_thread(listener.take_events, 2)
        assert finished == events.run_finished(
            notebook_id, "c1", uuid.UUID(started["execution_id"]), None
        )
    finally:
        listener.close()


@pytest.mark.anyio
async def test_an_unexpected_error_still_releases_the_lock(
    sessions: async_sessionmaker[AsyncSession], clean_db: str
) -> None:
    notebook_id, user_id = _seed(clean_db)
    runner = FakeRunner()
    runner.error = RuntimeError("a bug")
    runner.release.set()
    executions = Executions(sessions, runner, lock_ttl_seconds=30)
    with pytest.raises(RuntimeError, match="a bug"):
        await executions.run(notebook_id, "c1", "select 1", user_id, "Ada")
    assert _scalar(clean_db, "SELECT count(*) FROM cell_executions") == 0
    # And the next press runs normally.
    runner.error = None
    outcome, joined = await executions.run(notebook_id, "c1", "select 1", user_id, "Ada")
    assert isinstance(outcome, Stored) and not joined


@pytest.mark.anyio
async def test_a_joiner_in_the_same_process_waits_on_the_execution_itself(
    sessions: async_sessionmaker[AsyncSession], clean_db: str
) -> None:
    notebook_id, user_id = _seed(clean_db)
    runner = FakeRunner()
    # A poll interval this long would time the test out: the joiner must not poll.
    executions = Executions(sessions, runner, lock_ttl_seconds=30, poll_interval_seconds=60)
    try:
        first = asyncio.create_task(executions.run(notebook_id, "c1", "a", user_id, "Ada"))
        await runner.entered.wait()
        second = asyncio.create_task(executions.run(notebook_id, "c1", "b", user_id, "Ada"))
        await asyncio.sleep(0.2)
        runner.release.set()
        (one, one_joined), (two, two_joined) = await asyncio.wait_for(
            asyncio.gather(first, second), timeout=10
        )
        assert isinstance(one, Stored) and isinstance(two, Stored)
        assert one.run.id == two.run.id
        assert (one_joined, two_joined) == (False, True)
        assert runner.calls == 1
    finally:
        await executions.close()
