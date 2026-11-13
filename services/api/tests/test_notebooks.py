import asyncio
import json
import threading
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
import sqlalchemy as sa
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from notebook_api.config import Settings
from notebook_api.db.models import CellRun, Notebook
from notebook_api.main import create_app
from notebook_api.notebooks.executions import RUNS_KEPT_PER_CELL
from notebook_api.query.runner import QueryFailedError
from notebook_api.query.validate import MAX_SQL_CHARS
from tests.fixtures import auth_settings, browser, sign_in

SNAPSHOT_MAX = 2_000


@pytest.fixture
def client(clean_db: str, query_db: Path, tmp_path: Path) -> Iterator[TestClient]:
    settings = auth_settings(
        database_url=clean_db,
        duckdb_path=query_db,
        query_spill_dir=tmp_path / "spill",
        query_workers=1,
        query_row_limit=50,
        query_timeout_seconds=0.5,
        snapshot_max_bytes=SNAPSHOT_MAX,
    )
    with browser(create_app(settings)) as test_client:
        sign_in(test_client)
        yield test_client


def _create(client: TestClient, title: str = "Taxi trends") -> dict[str, Any]:
    response = client.post("/notebooks", json={"title": title})
    assert response.status_code == 201
    body: dict[str, Any] = response.json()
    return body


# --- notebooks -------------------------------------------------------------


def test_create_get_list_update_delete(client: TestClient) -> None:
    created = _create(client)
    assert created["title"] == "Taxi trends"
    notebook_id = created["id"]

    assert client.get(f"/notebooks/{notebook_id}").json()["title"] == "Taxi trends"
    assert [n["id"] for n in client.get("/notebooks").json()] == [notebook_id]

    renamed = client.patch(f"/notebooks/{notebook_id}", json={"title": "Renamed"})
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "Renamed"

    assert client.delete(f"/notebooks/{notebook_id}").status_code == 204
    assert client.get(f"/notebooks/{notebook_id}").status_code == 404


def test_list_is_most_recently_updated_first(client: TestClient) -> None:
    first = _create(client, "first")
    _create(client, "second")
    assert [n["title"] for n in client.get("/notebooks").json()] == ["second", "first"]
    # Saving content counts as an update, so "first" moves to the top.
    client.put(f"/notebooks/{first['id']}/snapshot", content=b"\x01")
    assert [n["title"] for n in client.get("/notebooks").json()] == ["first", "second"]


@pytest.mark.parametrize("title", ["", "x" * 201])
def test_title_is_validated(client: TestClient, title: str) -> None:
    assert client.post("/notebooks", json={"title": title}).status_code == 422


def test_title_validation_does_not_echo_private_input(client: TestClient) -> None:
    response = client.post("/notebooks", json={"title": "private-title-" * 100})
    assert response.status_code == 422
    assert response.json()["detail"]["kind"] == "invalid"
    assert "private-title" not in response.text
    assert len(response.content) < 1_000


def test_unknown_and_malformed_ids(client: TestClient) -> None:
    assert client.get(f"/notebooks/{uuid.uuid4()}").status_code == 404
    assert client.get("/notebooks/not-a-uuid").status_code == 422
    assert client.delete(f"/notebooks/{uuid.uuid4()}").status_code == 404


# --- snapshots -------------------------------------------------------------


def test_snapshot_is_empty_until_saved_then_round_trips(client: TestClient) -> None:
    notebook_id = _create(client)["id"]
    assert client.get(f"/notebooks/{notebook_id}/snapshot").status_code == 204

    state = bytes(range(256))
    assert client.put(f"/notebooks/{notebook_id}/snapshot", content=state).status_code == 204
    response = client.get(f"/notebooks/{notebook_id}/snapshot")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.content == state

    client.put(f"/notebooks/{notebook_id}/snapshot", content=b"newer")
    assert client.get(f"/notebooks/{notebook_id}/snapshot").content == b"newer"


def test_snapshot_save_bumps_updated_at(client: TestClient) -> None:
    created = _create(client)
    client.put(f"/notebooks/{created['id']}/snapshot", content=b"\x01")
    after = client.get(f"/notebooks/{created['id']}").json()
    # Compare as datetimes: as strings, a timestamp with zero microseconds
    # ("...:00Z") sorts after one with some ("...:00.0005Z").
    assert datetime.fromisoformat(after["updated_at"]) > datetime.fromisoformat(
        created["updated_at"]
    )


def test_snapshot_size_limit(client: TestClient) -> None:
    notebook_id = _create(client)["id"]
    url = f"/notebooks/{notebook_id}/snapshot"
    assert client.put(url, content=b"x" * SNAPSHOT_MAX).status_code == 204
    too_big = client.put(url, content=b"x" * (SNAPSHOT_MAX + 1))
    assert too_big.status_code == 413
    assert too_big.json()["detail"]["kind"] == "too_large"
    assert client.get(url).content == b"x" * SNAPSHOT_MAX  # unchanged


def test_snapshot_size_limit_holds_without_content_length(client: TestClient) -> None:
    # A chunked upload has no Content-Length; the streamed count still applies.
    notebook_id = _create(client)["id"]

    def chunks() -> Iterator[bytes]:
        for _ in range(SNAPSHOT_MAX // 100 + 1):
            yield b"x" * 100

    response = client.put(f"/notebooks/{notebook_id}/snapshot", content=chunks())
    assert response.status_code == 413


def test_empty_snapshot_is_rejected(client: TestClient) -> None:
    notebook_id = _create(client)["id"]
    assert client.put(f"/notebooks/{notebook_id}/snapshot", content=b"").status_code == 400


def test_snapshot_of_unknown_notebook(client: TestClient) -> None:
    url = f"/notebooks/{uuid.uuid4()}/snapshot"
    assert client.get(url).status_code == 404
    assert client.put(url, content=b"\x01").status_code == 404


def test_deleting_a_notebook_removes_its_snapshot_and_runs(
    client: TestClient, clean_db: str
) -> None:
    notebook_id = _create(client)["id"]
    client.put(f"/notebooks/{notebook_id}/snapshot", content=b"\x01")
    client.post(f"/notebooks/{notebook_id}/cells/c1/runs", json={"sql": "select 1"})
    client.delete(f"/notebooks/{notebook_id}")
    engine = sa.create_engine(clean_db)
    with engine.connect() as conn:
        for table in ("notebook_snapshots", "cell_runs"):
            assert conn.execute(sa.text(f"SELECT count(*) FROM {table}")).scalar() == 0
    engine.dispose()


# --- cell runs -------------------------------------------------------------


def _run(client: TestClient, notebook_id: str, sql: str, cell: str = "c1") -> dict[str, Any]:
    response = client.post(f"/notebooks/{notebook_id}/cells/{cell}/runs", json={"sql": sql})
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def test_a_successful_run_is_stored_and_shared(client: TestClient) -> None:
    notebook_id = _create(client)["id"]
    run = _run(client, notebook_id, "select count(*) as n from nums")
    assert run["status"] == "ok"
    assert run["error"] is None
    assert run["result"]["rows"] == [[10000]]
    assert run["cell_id"] == "c1"

    fetched = client.get(f"/notebooks/{notebook_id}/runs/{run['id']}")
    assert fetched.status_code == 200
    assert fetched.json() == run


@pytest.mark.parametrize(
    ("sql", "kind"),
    [
        ("drop table nums", "rejected"),
        ("select nope from nums", "error"),
        ("select sum(a.i * b.i) from nums a, nums b, nums c", "timeout"),
    ],
)
def test_a_failed_query_is_stored_as_an_error_run(client: TestClient, sql: str, kind: str) -> None:
    notebook_id = _create(client)["id"]
    run = _run(client, notebook_id, sql)
    assert run["status"] == "error"
    assert run["result"] is None
    assert run["error"]["kind"] == kind
    assert run["error"]["message"]


@pytest.mark.parametrize("kind", ["busy", "crashed"])
def test_service_failures_are_503_and_not_stored(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, kind: str, clean_db: str
) -> None:
    notebook_id = _create(client)["id"]
    runner = client.app.state.query_runner  # type: ignore[attr-defined]

    async def failing(sql: str) -> None:
        raise QueryFailedError(kind, "try again")  # type: ignore[arg-type]

    monkeypatch.setattr(runner, "run", failing)
    response = client.post(f"/notebooks/{notebook_id}/cells/c1/runs", json={"sql": "select 1"})
    assert response.status_code == 503
    assert response.json()["detail"]["kind"] == kind
    engine = sa.create_engine(clean_db)
    with engine.connect() as conn:
        assert conn.execute(sa.text("SELECT count(*) FROM cell_runs")).scalar() == 0
    engine.dispose()


def test_only_the_latest_runs_of_a_cell_are_kept(client: TestClient) -> None:
    notebook_id = _create(client)["id"]
    runs = [_run(client, notebook_id, f"select {i} as x") for i in range(RUNS_KEPT_PER_CELL + 2)]
    other_cell = _run(client, notebook_id, "select 'other' as x", cell="c2")

    kept = runs[-RUNS_KEPT_PER_CELL:]
    pruned = runs[:-RUNS_KEPT_PER_CELL]
    for run in [*kept, other_cell]:
        assert client.get(f"/notebooks/{notebook_id}/runs/{run['id']}").status_code == 200
    for run in pruned:
        assert client.get(f"/notebooks/{notebook_id}/runs/{run['id']}").status_code == 404


def test_a_run_is_only_visible_through_its_own_notebook(client: TestClient) -> None:
    first = _create(client, "first")["id"]
    second = _create(client, "second")["id"]
    run = _run(client, first, "select 1")
    assert client.get(f"/notebooks/{second}/runs/{run['id']}").status_code == 404
    assert client.get(f"/notebooks/{first}/runs/{uuid.uuid4()}").status_code == 404


@pytest.mark.parametrize("cell_id", ["has space", "x" * 65, "semi;colon", "dot.ted"])
def test_cell_ids_are_validated(client: TestClient, cell_id: str) -> None:
    notebook_id = _create(client)["id"]
    response = client.post(
        f"/notebooks/{notebook_id}/cells/{cell_id}/runs", json={"sql": "select 1"}
    )
    assert response.status_code == 422


def test_running_a_cell_of_an_unknown_notebook(client: TestClient) -> None:
    response = client.post(f"/notebooks/{uuid.uuid4()}/cells/c1/runs", json={"sql": "select 1"})
    assert response.status_code == 404


def test_nul_characters_in_results_survive_storage(client: TestClient) -> None:
    # Postgres jsonb rejects \u0000; cell_runs uses json, so this must round-trip.
    notebook_id = _create(client)["id"]
    run = _run(client, notebook_id, "select 'a' || chr(0) || 'b' as s")
    assert run["result"]["rows"] == [["a\x00b"]]
    fetched = client.get(f"/notebooks/{notebook_id}/runs/{run['id']}").json()
    assert fetched["result"]["rows"] == [["a\x00b"]]


def test_database_rejects_an_inconsistent_run(clean_db: str) -> None:
    engine = sa.create_engine(clean_db)
    with engine.begin() as conn:
        notebook_id = conn.execute(
            sa.insert(Notebook).values(id=uuid.uuid4(), title="t").returning(Notebook.id)
        ).scalar_one()
    bad_runs: list[tuple[str, dict[str, Any] | None, dict[str, Any] | None]] = [
        ("ok", None, None),
        ("error", {"rows": []}, {"kind": "error"}),
        ("maybe", None, {"kind": "error"}),
    ]
    for status, result, error in bad_runs:
        with pytest.raises(IntegrityError), engine.begin() as conn:
            conn.execute(
                sa.insert(CellRun).values(
                    id=uuid.uuid4(),
                    notebook_id=notebook_id,
                    cell_id="c1",
                    sql="select 1",
                    status=status,
                    result=result,
                    error=error,
                )
            )
    engine.dispose()


def test_routes_answer_503_without_a_database() -> None:
    settings = Settings(database_url=None, api_allowed_hosts=["testserver"])
    with TestClient(create_app(settings)) as client:
        response = client.get("/notebooks")
    assert response.status_code == 503
    assert response.json()["detail"]["kind"] == "unavailable"


def test_concurrent_first_snapshot_saves_do_not_collide(client: TestClient) -> None:
    # Two tabs opening a new notebook both save before either has a row.
    for _ in range(5):
        notebook_id = _create(client)["id"]
        url = f"/notebooks/{notebook_id}/snapshot"
        with ThreadPoolExecutor(max_workers=4) as pool:
            codes = list(
                pool.map(
                    lambda i, url=url: client.put(url, content=bytes([i + 1])).status_code,
                    range(4),
                )
            )
        assert codes == [204, 204, 204, 204]
        assert client.get(url).content in {b"\x01", b"\x02", b"\x03", b"\x04"}


class _Gate:
    def __init__(self) -> None:
        self.entered = threading.Event()  # the slow request is inside the runner
        self.release = threading.Event()  # let it finish


def _gate_slow_runs(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> _Gate:
    """Make SQL "slow" block inside the runner until released; other SQL runs normally."""
    gate = _Gate()
    runner = client.app.state.query_runner  # type: ignore[attr-defined]
    real_run = runner.run

    async def run(sql: str) -> Any:
        if sql == "slow":
            gate.entered.set()
            # The test sets a threading.Event from its own thread; wait for it
            # off the event loop.
            # (Bounded, so a broken test fails instead of hanging.)
            await asyncio.to_thread(gate.release.wait, 30)
            return await real_run("select 'slow' as x")
        return await real_run(sql)

    monkeypatch.setattr(runner, "run", run)
    return gate


def _expire_locks(url: str) -> None:
    engine = sa.create_engine(url)
    with engine.begin() as conn:
        conn.execute(sa.text("UPDATE cell_executions SET expires_at = now() - interval '1 second'"))
    engine.dispose()


def test_a_slow_run_is_never_pruned_by_runs_that_finished_during_it(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, clean_db: str
) -> None:
    # Runs of one cell normally can't overlap (the execution lock), but they
    # can once a slow execution's lock has expired and been taken over.
    gate = _gate_slow_runs(client, monkeypatch)
    notebook_id = _create(client)["id"]
    url = f"/notebooks/{notebook_id}/cells/c1/runs"
    with ThreadPoolExecutor(max_workers=1) as pool:
        slow = pool.submit(lambda: client.post(url, json={"sql": "slow"}))
        assert gate.entered.wait(timeout=10)  # the slow request started first
        _expire_locks(clean_db)
        fast = [_run(client, notebook_id, f"select {i} as x") for i in range(RUNS_KEPT_PER_CELL)]
        gate.release.set()
        slow_response = slow.result(timeout=30)

    assert slow_response.status_code == 201, slow_response.text
    slow_run = slow_response.json()
    assert slow_run["result"]["rows"] == [["slow"]]
    # The slow run finished last, so it is the newest and is kept, together
    # with the newest of the fast runs; the oldest fast run is pruned.
    assert client.get(f"/notebooks/{notebook_id}/runs/{slow_run['id']}").status_code == 200
    assert client.get(f"/notebooks/{notebook_id}/runs/{fast[0]['id']}").status_code == 404
    for run in fast[1:]:
        assert client.get(f"/notebooks/{notebook_id}/runs/{run['id']}").status_code == 200


def test_no_database_transaction_stays_open_while_a_query_runs(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, clean_db: str
) -> None:
    gate = _gate_slow_runs(client, monkeypatch)
    notebook_id = _create(client)["id"]
    url = f"/notebooks/{notebook_id}/cells/c1/runs"
    engine = sa.create_engine(clean_db)
    with ThreadPoolExecutor(max_workers=1) as pool:
        slow = pool.submit(lambda: client.post(url, json={"sql": "slow"}))
        try:
            assert gate.entered.wait(timeout=10)
            for _ in range(20):  # sample while the query is "running"
                with engine.connect() as conn:
                    idle_in_tx = conn.execute(
                        sa.text(
                            "SELECT count(*) FROM pg_stat_activity "
                            "WHERE datname = current_database() "
                            "AND state = 'idle in transaction'"
                        )
                    ).scalar()
                assert idle_in_tx == 0
                threading.Event().wait(0.01)
        finally:
            gate.release.set()
        assert slow.result(timeout=30).status_code == 201
    engine.dispose()


def test_deleting_a_notebook_while_its_cell_runs_returns_404(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    gate = _gate_slow_runs(client, monkeypatch)
    notebook_id = _create(client)["id"]
    url = f"/notebooks/{notebook_id}/cells/c1/runs"
    with ThreadPoolExecutor(max_workers=1) as pool:
        slow = pool.submit(lambda: client.post(url, json={"sql": "slow"}))
        assert gate.entered.wait(timeout=10)
        assert client.delete(f"/notebooks/{notebook_id}").status_code == 204
        gate.release.set()
        response = slow.result(timeout=30)
    assert response.status_code == 404
    assert response.json()["detail"]["kind"] == "not_found"


def test_deleting_a_notebook_while_snapshots_are_being_saved(client: TestClient) -> None:
    # A tab keeps saving (debounced) while someone deletes the notebook. The
    # delete must always succeed, and saves must be 204 (before) or 404 (after),
    # never a deadlock or foreign-key error.
    for _ in range(20):
        notebook_id = _create(client)["id"]
        url = f"/notebooks/{notebook_id}/snapshot"
        client.put(url, content=b"\x00")  # the snapshot row already exists
        start = threading.Barrier(4)

        def save(i: int, url: str = url, start: threading.Barrier = start) -> int:
            start.wait()
            return client.put(url, content=bytes([i + 1])).status_code

        def remove(notebook_id: str = notebook_id, start: threading.Barrier = start) -> int:
            start.wait()
            return client.delete(f"/notebooks/{notebook_id}").status_code

        with ThreadPoolExecutor(max_workers=4) as pool:
            saves = [pool.submit(save, i) for i in range(3)]
            deleted = pool.submit(remove)
            assert deleted.result(timeout=30) == 204
            assert {f.result(timeout=30) for f in saves} <= {204, 404}
        assert client.get(f"/notebooks/{notebook_id}").status_code == 404


def test_constraint_bugs_in_run_storage_are_not_reported_as_not_found(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # If application code ever built an inconsistent run, the database's check
    # constraint would reject it. That's a bug, so it must not become a 404.
    notebook_id = _create(client)["id"]
    real_init = CellRun.__init__

    def broken_init(self: CellRun, **kwargs: Any) -> None:
        real_init(self, **{**kwargs, "status": "ok", "result": None})

    monkeypatch.setattr(CellRun, "__init__", broken_init)
    with pytest.raises(IntegrityError):
        client.post(f"/notebooks/{notebook_id}/cells/c1/runs", json={"sql": "select 1"})


# --- request validation ----------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [{"sql": "private-sql-" * 2_000}, {"sql": {"secret": "private-value"}}, {}],
)
def test_validation_errors_name_the_problem_without_echoing_input(
    client: TestClient, body: dict[str, object]
) -> None:
    notebook_id = _create(client)["id"]
    response = client.post(f"/notebooks/{notebook_id}/cells/c1/runs", json=body)
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["kind"] == "invalid"
    assert "sql" in detail["message"]
    assert "private-" not in response.text
    assert len(response.content) < 1_000


def test_a_too_long_query_says_so(client: TestClient) -> None:
    notebook_id = _create(client)["id"]
    response = client.post(
        f"/notebooks/{notebook_id}/cells/c1/runs", json={"sql": "select 1 " * 3_000}
    )
    assert response.status_code == 422
    assert "at most 20000 characters" in response.json()["detail"]["message"]


def test_the_longest_allowed_query_fits_the_body_cap_in_the_worst_encoding(
    client: TestClient,
) -> None:
    # The worst case for JSON size: every character outside the BMP, sent
    # ASCII-escaped as a surrogate pair (12 bytes each). 20,000 of them must
    # still reach validation (and run), not be refused by the 256 KiB body cap.
    notebook_id = _create(client)["id"]
    filler = "\U0001f600" * (MAX_SQL_CHARS - len("select ''"))
    sql = f"select '{filler}'"
    assert len(sql) == MAX_SQL_CHARS
    body = json.dumps({"sql": sql}, ensure_ascii=True).encode()
    assert 239_000 < len(body) <= 262_144
    path = f"/notebooks/{notebook_id}/cells/c1/runs"
    headers = {"Content-Type": "application/json"}
    response = client.post(path, content=body, headers=headers)
    assert response.status_code == 201, response.text
    assert response.json()["status"] == "ok"

    # One more character is a validation error, still not a 413.
    longer = json.dumps({"sql": sql + " "}, ensure_ascii=True).encode()
    response = client.post(path, content=longer, headers=headers)
    assert response.status_code == 422
    assert "at most 20000 characters" in response.json()["detail"]["message"]


def test_a_bad_path_parameter_names_the_rule_not_the_value(client: TestClient) -> None:
    response = client.get("/notebooks/PRIVATE-not-a-uuid")
    assert response.status_code == 422
    assert response.json() == {
        "detail": {
            "kind": "invalid",
            "message": "Invalid request: path.notebook_id must be a UUID.",
        }
    }


def test_malformed_json_is_reported_without_echoing_the_body(client: TestClient) -> None:
    notebook_id = _create(client)["id"]
    response = client.post(
        f"/notebooks/{notebook_id}/cells/c1/runs",
        content=b'{"sql":"private-value"',
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert response.json()["detail"]["kind"] == "invalid"
    assert "private-value" not in response.text


def test_a_large_result_is_stored_and_returned(client: TestClient) -> None:
    # Replies larger than a pipe buffer must survive the worker pipe, storage
    # and the response. (Moved here from the removed POST /query route.)
    notebook_id = _create(client)["id"]
    run = _run(client, notebook_id, "select i, repeat('x', 4000) as s from nums order by i")
    assert run["result"]["row_count"] == 50
    fetched = client.get(f"/notebooks/{notebook_id}/runs/{run['id']}")
    assert len(fetched.content) > 200_000


def test_running_a_cell_answers_503_without_a_query_engine(clean_db: str) -> None:
    settings = auth_settings(database_url=clean_db, duckdb_path=None)
    with browser(create_app(settings)) as no_engine:
        sign_in(no_engine)
        notebook_id = _create(no_engine)["id"]
        response = no_engine.post(
            f"/notebooks/{notebook_id}/cells/c1/runs", json={"sql": "select 1"}
        )
    assert response.status_code == 503
    assert response.json()["detail"]["kind"] == "unavailable"
