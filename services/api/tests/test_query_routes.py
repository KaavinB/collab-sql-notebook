from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from notebook_api.config import Settings
from notebook_api.main import create_app


@pytest.fixture
def client(query_db: Path, tmp_path: Path) -> Iterator[TestClient]:
    settings = Settings(
        duckdb_path=query_db,
        query_spill_dir=tmp_path / "spill",
        query_workers=1,
        query_row_limit=50,
        query_timeout_seconds=0.5,
        api_allowed_hosts=["testserver"],
    )
    # Entering the client runs the app's lifespan, which starts the workers.
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def test_returns_a_result_table(client: TestClient) -> None:
    response = client.post("/query", json={"sql": "select i from nums order by i"})
    assert response.status_code == 200
    body = response.json()
    assert body["columns"] == [{"name": "i", "type": "BIGINT"}]
    assert body["row_count"] == 50
    assert body["truncated"] is True
    assert body["rows"][:2] == [[0], [1]]


@pytest.mark.parametrize(
    ("sql", "status", "kind"),
    [
        ("drop table nums", 400, "rejected"),
        ("select 'unterminated", 400, "rejected"),
        ("select nope from nums", 400, "error"),
        ("select * from read_csv('/etc/passwd')", 400, "error"),
        ("select sum(a.i * b.i) from nums a, nums b, nums c", 400, "timeout"),
    ],
)
def test_reports_failures_with_a_kind(client: TestClient, sql: str, status: int, kind: str) -> None:
    response = client.post("/query", json={"sql": sql})
    assert response.status_code == status
    assert response.json()["detail"]["kind"] == kind
    assert response.json()["detail"]["message"]


@pytest.mark.parametrize("sql", ["", "x" * 20_001])
def test_validates_the_request_body(client: TestClient, sql: str) -> None:
    assert client.post("/query", json={"sql": sql}).status_code == 422


def test_answers_503_when_no_database_is_configured() -> None:
    settings = Settings(duckdb_path=None, api_allowed_hosts=["testserver"])
    with TestClient(create_app(settings)) as client:
        response = client.post("/query", json={"sql": "select 1"})
    assert response.status_code == 503
    assert response.json()["detail"]["kind"] == "unavailable"


def test_returns_a_large_result(client: TestClient) -> None:
    response = client.post(
        "/query", json={"sql": "select i, repeat('x', 4000) as s from nums order by i"}
    )
    assert response.status_code == 200
    assert response.json()["row_count"] == 50
    assert len(response.content) > 200_000
