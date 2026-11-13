import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from notebook_api.config import Settings
from notebook_api.main import create_app

ALLOWED = "http://localhost:3000"


def _client() -> TestClient:
    # TestClient sends Host: testserver.
    settings = Settings(api_cors_origins=[ALLOWED], api_allowed_hosts=["testserver"])
    return TestClient(create_app(settings))


def test_health_returns_ok() -> None:
    response = _client().get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_cors_allows_configured_origin() -> None:
    response = _client().get("/health", headers={"Origin": ALLOWED})
    assert response.headers["access-control-allow-origin"] == ALLOWED


def test_cors_rejects_unlisted_origin() -> None:
    response = _client().get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in response.headers


def _preflight(origin: str) -> dict[str, str]:
    return {
        "Origin": origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
    }


def test_cors_preflight_allows_configured_origin() -> None:
    response = _client().options("/health", headers=_preflight(ALLOWED))
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ALLOWED
    assert "POST" in response.headers["access-control-allow-methods"]


def test_cors_preflight_rejects_unlisted_origin() -> None:
    response = _client().options("/health", headers=_preflight("https://evil.example"))
    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_cors_origins_parse_from_comma_separated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("API_CORS_ORIGINS", "http://a.test, http://b.test ,")
    assert Settings().api_cors_origins == ["http://a.test", "http://b.test"]


@pytest.mark.parametrize("value", ["*", "http://a.test,*"])
def test_cors_wildcard_is_rejected(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("API_CORS_ORIGINS", value)
    with pytest.raises(ValidationError, match="explicit origins"):
        Settings()


def test_defaults_are_safe_for_production() -> None:
    settings = Settings()
    assert settings.api_host == "127.0.0.1"
    assert settings.api_port == 8010
    assert settings.api_reload is False


def test_reload_is_read_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("API_RELOAD", "true")
    assert Settings().api_reload is True


def test_unknown_host_header_is_rejected() -> None:
    # DNS rebinding: a hostile page resolves its own domain to 127.0.0.1.
    response = _client().get("/health", headers={"Host": "evil.example"})
    assert response.status_code == 400


def test_default_allowed_hosts_are_local_only() -> None:
    assert Settings().api_allowed_hosts == ["127.0.0.1", "localhost"]


def test_allowed_hosts_parse_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("API_ALLOWED_HOSTS", "api.example.com, localhost")
    assert Settings().api_allowed_hosts == ["api.example.com", "localhost"]


def test_process_memory_cap_must_exceed_duckdb_limit() -> None:
    with pytest.raises(ValidationError, match="QUERY_PROCESS_MEMORY_CAP_MB"):
        Settings(query_memory_limit_mb=1024, query_process_memory_cap_mb=1024)


@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        ("postgresql+psycopg://u:p@localhost/notebook_test", True),
        ("postgresql+psycopg://u:p@localhost/notebook", False),
        ("postgresql+psycopg://u:p@localhost/test_notebook", False),
        ("postgresql+psycopg://u:p@localhost/", False),
    ],
)
def test_tests_refuse_a_database_not_named_test(url: str, allowed: bool) -> None:
    from tests.conftest import require_test_database

    if allowed:
        assert require_test_database(url) == url
    else:
        with pytest.raises(ValueError, match="must end in '_test'"):
            require_test_database(url)


@pytest.mark.parametrize(
    "path",
    [
        "/notebooks",
        "/notebooks/not-a-uuid",
        "/notebooks/4e7cec47-ee07-48e8-b7cd-3b878e00aa86/cells/c1/runs",
    ],
)
def test_json_bodies_are_capped_before_validation(path: str) -> None:
    # 413 comes from the middleware, before routing, validation or any
    # database dependency: this app has no database configured at all.
    response = _client().request(
        "PATCH" if path.endswith("not-a-uuid") else "POST",
        path,
        content=b'{"ignored":"' + b"x" * 262_144 + b'"}',
        headers={"Content-Type": "application/json", "Origin": ALLOWED},
    )
    assert response.status_code == 413
    assert response.json()["detail"]["kind"] == "too_large"
    assert response.headers["access-control-allow-origin"] == ALLOWED
