"""Sign-in (OAuth and dev), sessions, the Origin check, and notebook membership."""

import base64
import hashlib
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx2
import psycopg
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError
from sqlalchemy.engine import make_url

from notebook_api.auth import tokens
from notebook_api.config import Settings
from notebook_api.main import create_app
from tests.fixtures import SESSION_COOKIE, WEB_ORIGIN, auth_settings, browser, sign_in

# --- signed tokens ----------------------------------------------------------

SECRET = b"k" * 32


def test_a_signed_token_round_trips() -> None:
    token = tokens.sign({"a": 1}, secret=SECRET, purpose="p", ttl_seconds=60, now=1000)
    assert tokens.verify(token, secret=SECRET, purpose="p", now=1059) == {"a": 1, "exp": 1060}


@pytest.mark.parametrize(
    ("secret", "purpose", "now"),
    [
        (b"x" * 32, "p", 1000),  # wrong key
        (SECRET, "other", 1000),  # minted for another purpose
        (SECRET, "p", 1060),  # expired
    ],
)
def test_a_token_is_rejected_with_the_wrong_key_purpose_or_time(
    secret: bytes, purpose: str, now: float
) -> None:
    token = tokens.sign({"a": 1}, secret=SECRET, purpose="p", ttl_seconds=60, now=1000)
    assert tokens.verify(token, secret=secret, purpose=purpose, now=now) is None


def test_a_tampered_or_malformed_token_is_rejected() -> None:
    token = tokens.sign({"role": "viewer"}, secret=SECRET, purpose="p", ttl_seconds=60)
    payload, mac = token.split(".")
    forged = base64.urlsafe_b64encode(b'{"exp":9999999999,"role":"owner"}').rstrip(b"=")
    for bad in [f"{forged.decode()}.{mac}", payload, "", "a.b.c", "é.é", "x" * 5000]:
        assert tokens.verify(bad, secret=SECRET, purpose="p") is None


# --- settings ---------------------------------------------------------------


def test_a_short_auth_secret_is_refused() -> None:
    with pytest.raises(ValidationError, match="at least 32"):
        Settings(auth_secret=SecretStr("short"))


def test_the_web_url_must_be_an_allowed_origin() -> None:
    with pytest.raises(ValidationError, match="WEB_URL"):
        Settings(web_url="https://app.example.com")


_LOCAL_DEV: dict[str, Any] = {"auth_dev_login": True, "auth_cookie_secure": False}


@pytest.mark.parametrize(
    "overrides",
    [
        {"api_host": "0.0.0.0"},  # noqa: S104
        {"api_host": "10.0.0.5"},
        # A deployment-shaped config that leaves API_HOST at its default:
        # started with `uvicorn --host 0.0.0.0`, or behind a proxy.
        {"api_allowed_hosts": ["api.notebook.example.com"]},
        {"api_allowed_hosts": ["localhost", "api.notebook.example.com"]},
        {
            "web_url": "https://notebook.example.com",
            "api_cors_origins": ["https://notebook.example.com"],
        },
        {"api_public_url": "https://api.notebook.example.com"},
        {"auth_cookie_secure": True},
    ],
)
def test_dev_login_is_refused_unless_everything_is_local(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError, match="AUTH_DEV_LOGIN"):
        Settings(**{**_LOCAL_DEV, **overrides})


@pytest.mark.parametrize("host", ["127.0.0.1", "::1", "localhost"])
def test_dev_login_is_allowed_on_loopback(host: str) -> None:
    assert Settings(api_host=host, **_LOCAL_DEV).auth_dev_login


def test_the_session_cookie_name_is_app_specific_and_host_bound_over_https() -> None:
    from notebook_api.auth.sessions import session_cookie_name

    assert session_cookie_name(Settings(auth_cookie_secure=False)) == "notebook_session"
    assert session_cookie_name(Settings()) == "__Host-notebook_session"


# --- a fake OAuth provider ----------------------------------------------------


class FakeProvider:
    """Plays GitHub's or Google's token and profile endpoints, and checks PKCE."""

    def __init__(self, profile: dict[str, Any]) -> None:
        self.profile = profile
        self.challenge: str | None = None
        self.token_requests: list[dict[str, list[str]]] = []
        self.token_status = 200

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        if request.url.path in ("/login/oauth/access_token", "/token"):
            form = parse_qs(request.content.decode())
            self.token_requests.append(form)
            verifier = form["code_verifier"][0]
            digest = hashlib.sha256(verifier.encode()).digest()
            if base64.urlsafe_b64encode(digest).rstrip(b"=").decode() != self.challenge:
                return httpx2.Response(400, json={"error": "invalid_grant"})
            if form["code"] != ["good-code"]:
                return httpx2.Response(200, json={"error": "bad_verification_code"})
            return httpx2.Response(self.token_status, json={"access_token": "provider-token"})
        if request.headers.get("authorization") != "Bearer provider-token":
            return httpx2.Response(401)
        return httpx2.Response(200, json=self.profile)


@pytest.fixture
def provider() -> FakeProvider:
    return FakeProvider({"id": 4242, "login": "ada", "name": "Ada Lovelace"})


@pytest.fixture
def oauth_client(clean_db: str, provider: FakeProvider) -> Iterator[TestClient]:
    settings = auth_settings(
        database_url=clean_db,
        auth_dev_login=False,
        github_client_id="gh-id",
        github_client_secret=SecretStr("gh-secret"),
        google_client_id="g-id",
        google_client_secret=SecretStr("g-secret"),
    )
    app = create_app(settings, oauth_transport=httpx2.MockTransport(provider.handle))
    with browser(app) as client:
        yield client


def _start(
    client: TestClient, provider: FakeProvider, name: str = "github", next_path: str = "/"
) -> str:
    """Begin a sign-in; return the state the provider was given."""
    response = client.get(f"/auth/{name}/login", params={"next": next_path}, follow_redirects=False)
    assert response.status_code == 303
    query = parse_qs(urlsplit(response.headers["location"]).query)
    assert query["code_challenge_method"] == ["S256"]
    assert query["redirect_uri"] == [f"http://localhost:8010/auth/{name}/callback"]
    provider.challenge = query["code_challenge"][0]
    return query["state"][0]


def _finish(client: TestClient, state: str, name: str = "github", code: str = "good-code") -> Any:
    return client.get(
        f"/auth/{name}/callback", params={"code": code, "state": state}, follow_redirects=False
    )


def test_providers_lists_what_is_configured(oauth_client: TestClient) -> None:
    assert oauth_client.get("/auth/providers").json() == {
        "providers": ["github", "google"],
        "dev_login": False,
    }


def test_nothing_is_offered_without_an_auth_secret(clean_db: str) -> None:
    settings = auth_settings(
        database_url=clean_db,
        auth_secret=None,
        github_client_id="gh-id",
        github_client_secret=SecretStr("gh-secret"),
    )
    with browser(create_app(settings)) as client:
        assert client.get("/auth/providers").json() == {"providers": [], "dev_login": False}
        response = client.get("/auth/github/login", follow_redirects=False)
        assert response.status_code == 503


def test_github_sign_in_creates_a_session(oauth_client: TestClient, provider: FakeProvider) -> None:
    state = _start(oauth_client, provider, next_path="/notebooks/abc")
    response = _finish(oauth_client, state)
    assert response.status_code == 303
    assert response.headers["location"] == f"{WEB_ORIGIN}/notebooks/abc"
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie
    me = oauth_client.get("/auth/me")
    assert me.status_code == 200
    assert me.json()["name"] == "Ada Lovelace"
    # The provider got the PKCE verifier, the client secret and the same redirect URI.
    (form,) = provider.token_requests
    assert form["client_secret"] == ["gh-secret"]
    assert form["redirect_uri"] == ["http://localhost:8010/auth/github/callback"]


def test_signing_in_again_is_the_same_user_with_a_refreshed_name(
    oauth_client: TestClient, provider: FakeProvider
) -> None:
    _finish(oauth_client, _start(oauth_client, provider))
    first = oauth_client.get("/auth/me").json()
    provider.profile = {"id": 4242, "login": "ada", "name": "Countess Lovelace"}
    _finish(oauth_client, _start(oauth_client, provider))
    second = oauth_client.get("/auth/me").json()
    assert second == {"id": first["id"], "name": "Countess Lovelace"}


def test_google_sign_in_uses_the_openid_subject(
    oauth_client: TestClient, provider: FakeProvider
) -> None:
    provider.profile = {"sub": "google-123", "name": "Grace Hopper"}
    response = _finish(oauth_client, _start(oauth_client, provider, "google"), "google")
    assert response.status_code == 303
    assert oauth_client.get("/auth/me").json()["name"] == "Grace Hopper"


@pytest.mark.parametrize(
    "next_path", ["//evil.example", "/\\evil.example", "https://evil.example", "x"]
)
def test_an_unsafe_next_path_falls_back_to_home(
    oauth_client: TestClient, provider: FakeProvider, next_path: str
) -> None:
    response = _finish(oauth_client, _start(oauth_client, provider, next_path=next_path))
    assert response.headers["location"] == f"{WEB_ORIGIN}/"


def test_a_wrong_state_is_refused(oauth_client: TestClient, provider: FakeProvider) -> None:
    _start(oauth_client, provider)
    response = _finish(oauth_client, "attacker-state")
    assert response.headers["location"] == f"{WEB_ORIGIN}/?signin_error=failed"
    assert oauth_client.get("/auth/me").status_code == 401


def test_a_callback_without_the_flow_cookie_is_refused(
    oauth_client: TestClient, provider: FakeProvider
) -> None:
    # Login CSRF: an attacker's own code and state, delivered to a victim's browser.
    state = _start(oauth_client, provider)
    oauth_client.cookies.clear()
    response = _finish(oauth_client, state)
    assert response.headers["location"] == f"{WEB_ORIGIN}/?signin_error=expired"
    assert provider.token_requests == []


def test_a_flow_started_for_one_provider_cannot_finish_at_another(
    oauth_client: TestClient, provider: FakeProvider
) -> None:
    state = _start(oauth_client, provider, "github")
    response = _finish(oauth_client, state, "google")
    assert response.headers["location"] == f"{WEB_ORIGIN}/?signin_error=failed"


def test_a_rejected_code_or_cancelled_sign_in_creates_no_session(
    oauth_client: TestClient, provider: FakeProvider
) -> None:
    response = _finish(oauth_client, _start(oauth_client, provider), code="stolen-code")
    assert response.headers["location"] == f"{WEB_ORIGIN}/?signin_error=failed"
    cancelled = oauth_client.get(
        "/auth/github/callback", params={"error": "access_denied"}, follow_redirects=False
    )
    assert cancelled.headers["location"] == f"{WEB_ORIGIN}/?signin_error=denied"
    assert oauth_client.get("/auth/me").status_code == 401


def test_an_unconfigured_provider_is_not_found(clean_db: str) -> None:
    with browser(create_app(auth_settings(database_url=clean_db))) as client:
        assert client.get("/auth/github/login", follow_redirects=False).status_code == 404
        assert client.get("/auth/twitter/login", follow_redirects=False).status_code == 422


# --- sessions -------------------------------------------------------------------


@pytest.fixture
def client(clean_db: str, query_db: Path, tmp_path: Path) -> Iterator[TestClient]:
    settings = auth_settings(
        database_url=clean_db,
        duckdb_path=query_db,
        query_spill_dir=tmp_path / "spill",
        query_workers=1,
    )
    with browser(create_app(settings)) as test_client:
        yield test_client


def _sql(url: str) -> psycopg.Connection[Any]:
    return psycopg.connect(
        make_url(url).set(drivername="postgresql").render_as_string(hide_password=False),
        autocommit=True,
    )


def test_only_a_hash_of_the_session_token_is_stored(client: TestClient, clean_db: str) -> None:
    sign_in(client)
    token = client.cookies[SESSION_COOKIE]
    with _sql(clean_db) as conn:
        stored = conn.execute("SELECT token_hash FROM auth_sessions").fetchall()
    assert stored == [(hashlib.sha256(token.encode()).digest(),)]


def test_signing_out_ends_the_session_everywhere(client: TestClient) -> None:
    sign_in(client)
    token = client.cookies[SESSION_COOKIE]
    assert client.post("/auth/logout").status_code == 204
    client.cookies.set(SESSION_COOKIE, token)  # a copy of the old cookie no longer works
    assert client.get("/auth/me").status_code == 401


def test_an_expired_session_is_refused(client: TestClient, clean_db: str) -> None:
    sign_in(client)
    with _sql(clean_db) as conn:
        conn.execute("UPDATE auth_sessions SET expires_at = now() - interval '1 second'")
    response = client.get("/notebooks")
    assert response.status_code == 401
    assert response.json()["detail"]["kind"] == "unauthenticated"


def test_every_notebook_route_needs_a_session(client: TestClient) -> None:
    some_id = uuid.uuid4()
    for method, path in [
        ("GET", "/notebooks"),
        ("POST", "/notebooks"),
        ("GET", f"/notebooks/{some_id}"),
        ("PATCH", f"/notebooks/{some_id}"),
        ("DELETE", f"/notebooks/{some_id}"),
        ("GET", f"/notebooks/{some_id}/snapshot"),
        ("PUT", f"/notebooks/{some_id}/snapshot"),
        ("POST", f"/notebooks/{some_id}/cells/c1/runs"),
        ("GET", f"/notebooks/{some_id}/runs/{some_id}"),
        ("POST", f"/notebooks/{some_id}/share-links"),
        ("GET", f"/notebooks/{some_id}/share-links"),
        ("DELETE", f"/notebooks/{some_id}/share-links/{some_id}"),
        ("POST", "/share-links/accept"),
        ("GET", f"/notebooks/{some_id}/members"),
        ("PATCH", f"/notebooks/{some_id}/members/{some_id}"),
        ("DELETE", f"/notebooks/{some_id}/members/{some_id}"),
        ("POST", f"/notebooks/{some_id}/sync-ticket"),
    ]:
        body = (
            {"title": "x", "sql": "select 1", "role": "viewer", "token": "t"}
            if method in ("POST", "PATCH")
            else None
        )
        response = client.request(
            method, path, json=body, content=b"x" if method == "PUT" else None
        )
        assert response.status_code == 401, (method, path, response.text)


@pytest.mark.parametrize("name", ["   ", "..", " - "])
def test_dev_login_needs_a_real_name(client: TestClient, name: str) -> None:
    response = client.post("/auth/dev-login", json={"name": name})
    assert response.status_code == 422


def test_dev_login_trims_the_name(client: TestClient) -> None:
    assert sign_in(client, "  Ada  ")["name"] == "Ada"


def test_dev_login_is_off_unless_enabled(clean_db: str) -> None:
    with browser(create_app(auth_settings(database_url=clean_db, auth_dev_login=False))) as client:
        response = client.post("/auth/dev-login", json={"name": "Mallory"})
    assert response.status_code == 404


# --- the Origin check -------------------------------------------------------------


@pytest.mark.parametrize("origin", [None, "https://evil.example", "null"])
def test_state_changing_requests_from_elsewhere_are_refused(
    clean_db: str, origin: str | None
) -> None:
    app = create_app(auth_settings(database_url=clean_db))
    with TestClient(app, base_url="http://localhost") as client:  # sends no Origin
        headers = {"Origin": origin} if origin else {}
        response = client.post("/auth/dev-login", json={"name": "Ada"}, headers=headers)
    assert response.status_code == 403
    assert response.json()["detail"]["kind"] == "forbidden"


def test_reads_do_not_need_an_origin(clean_db: str) -> None:
    app = create_app(auth_settings(database_url=clean_db))
    with TestClient(app, base_url="http://localhost") as client:  # sends no Origin
        assert client.get("/auth/providers").status_code == 200


def test_cors_allows_credentials_for_the_web_app(client: TestClient) -> None:
    response = client.get("/auth/providers", headers={"Origin": WEB_ORIGIN})
    assert response.headers["access-control-allow-origin"] == WEB_ORIGIN
    assert response.headers["access-control-allow-credentials"] == "true"


# --- membership -------------------------------------------------------------------


def _second_user(clean_db: str, name: str, query_db: Path | None = None) -> TestClient:
    other = browser(create_app(auth_settings(database_url=clean_db, duckdb_path=query_db)))
    other.__enter__()
    sign_in(other, name)
    return other


def _add_member(clean_db: str, notebook_id: str, user_id: str, role: str) -> None:
    with _sql(clean_db) as conn:
        conn.execute(
            "INSERT INTO notebook_members (notebook_id, user_id, role) VALUES (%s, %s, %s)",
            (notebook_id, user_id, role),
        )


def test_notebooks_are_private_to_their_members(client: TestClient, clean_db: str) -> None:
    sign_in(client, "Ada")
    notebook = client.post("/notebooks", json={"title": "Ada's"}).json()
    assert notebook["role"] == "owner"
    url = f"/notebooks/{notebook['id']}"
    run = client.post(f"{url}/cells/c1/runs", json={"sql": "select 1 as x"})
    assert run.status_code == 201
    other = _second_user(clean_db, "Mallory")
    try:
        assert other.get("/notebooks").json() == []
        # Every route answers exactly as for a notebook that doesn't exist.
        attempts: list[tuple[str, str, dict[str, Any]]] = [
            ("GET", url, {}),
            ("PATCH", url, {"json": {"title": "mine"}}),
            ("DELETE", url, {}),
            ("GET", f"{url}/snapshot", {}),
            ("PUT", f"{url}/snapshot", {"content": b"x"}),
            ("POST", f"{url}/cells/c1/runs", {"json": {"sql": "select 1"}}),
            ("GET", f"{url}/runs/{run.json()['id']}", {}),
        ]
        for method, path, kwargs in attempts:
            response = other.request(method, path, **kwargs)
            assert response.status_code == 404, (method, path)
            assert response.json()["detail"]["message"] == "Notebook not found."
    finally:
        other.__exit__(None, None, None)


def test_roles_limit_what_members_can_do(client: TestClient, clean_db: str, query_db: Path) -> None:
    sign_in(client, "Ada")
    notebook_id = client.post("/notebooks", json={"title": "Shared"}).json()["id"]
    viewer = _second_user(clean_db, "Vera")
    editor = _second_user(clean_db, "Ed", query_db)
    try:
        _add_member(clean_db, notebook_id, viewer.get("/auth/me").json()["id"], "viewer")
        _add_member(clean_db, notebook_id, editor.get("/auth/me").json()["id"], "editor")
        url = f"/notebooks/{notebook_id}"

        assert viewer.get(url).json()["role"] == "viewer"
        assert viewer.get(f"{url}/snapshot").status_code == 204
        for refused in [
            viewer.patch(url, json={"title": "x"}),
            viewer.put(f"{url}/snapshot", content=b"x"),
            viewer.post(f"{url}/cells/c1/runs", json={"sql": "select 1"}),
            viewer.delete(url),
            editor.delete(url),
        ]:
            assert refused.status_code == 403
            assert refused.json()["detail"]["kind"] == "forbidden"

        assert editor.patch(url, json={"title": "Renamed"}).status_code == 200
        assert editor.put(f"{url}/snapshot", content=b"x").status_code == 204
        ran = editor.post(f"{url}/cells/c1/runs", json={"sql": "select 1 as x"})
        assert ran.status_code == 201
        seen = viewer.get(f"{url}/runs/{ran.json()['id']}")
        assert seen.status_code == 200
        assert seen.json()["result"]["rows"] == [[1]]
        assert [n["role"] for n in editor.get("/notebooks").json()] == ["editor"]
        assert client.delete(url).status_code == 204
    finally:
        viewer.__exit__(None, None, None)
        editor.__exit__(None, None, None)
