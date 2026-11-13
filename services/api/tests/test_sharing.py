"""Share links, members, sync tickets, and the access notifications they send."""

import base64
import hashlib
import hmac
import json
import time
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from notebook_api import events
from notebook_api.auth import tokens
from notebook_api.config import Settings
from notebook_api.main import create_app
from notebook_api.notebooks import sharing
from notebook_api.notebooks.sharing import MAX_SHARE_LINKS_PER_NOTEBOOK
from tests.fixtures import (
    TEST_AUTH_SECRET,
    Listener,
    add_member,
    auth_settings,
    browser,
    compact,
    sign_in,
    sql_connection,
)

SYNC_SECRET = "sync-secret-" + "y" * 32
SYNC_URL = "wss://sync.localhost:8443"


def _settings(clean_db: str, **overrides: Any) -> Settings:
    return auth_settings(
        database_url=clean_db,
        sync_ticket_secret=SecretStr(SYNC_SECRET),
        sync_public_url=SYNC_URL,
        **overrides,
    )


@contextmanager
def _user(clean_db: str, name: str, **overrides: Any) -> Iterator[TestClient]:
    """A browser signed in as a new user."""
    with browser(create_app(_settings(clean_db, **overrides))) as client:
        sign_in(client, name)
        yield client


@pytest.fixture
def owner(clean_db: str) -> Iterator[TestClient]:
    with _user(clean_db, "Ada") as client:
        yield client


@pytest.fixture
def listener(clean_db: str) -> Iterator[Listener]:
    listening = Listener(clean_db)
    yield listening
    listening.close()


def _notebook(client: TestClient, title: str = "Shared") -> str:
    response = client.post("/notebooks", json={"title": title})
    assert response.status_code == 201
    notebook_id: str = response.json()["id"]
    return notebook_id


def _link(client: TestClient, notebook_id: str, role: str) -> dict[str, Any]:
    response = client.post(f"/notebooks/{notebook_id}/share-links", json={"role": role})
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def _me(client: TestClient) -> str:
    user_id: str = client.get("/auth/me").json()["id"]
    return user_id


def _accept(client: TestClient, token: str) -> Any:
    return client.post("/share-links/accept", json={"token": token})


# --- share links ------------------------------------------------------------------


def test_a_share_link_shows_its_token_once_and_stores_only_a_hash(
    owner: TestClient, clean_db: str
) -> None:
    notebook_id = _notebook(owner)
    link = _link(owner, notebook_id, "editor")
    assert set(link) == {"id", "role", "token", "created_at"}
    assert link["role"] == "editor"
    assert len(link["token"]) == 43  # 32 random bytes, base64url

    listed = owner.get(f"/notebooks/{notebook_id}/share-links").json()
    assert listed == [{"id": link["id"], "role": "editor", "created_at": link["created_at"]}]
    with sql_connection(clean_db) as conn:
        stored = conn.execute("SELECT token_hash FROM share_links").fetchall()
    assert stored == [(hashlib.sha256(link["token"].encode()).digest(),)]


def test_accepting_a_link_makes_you_a_member_with_its_role(
    owner: TestClient, clean_db: str
) -> None:
    notebook_id = _notebook(owner)
    viewer_link = _link(owner, notebook_id, "viewer")
    with _user(clean_db, "Vera") as vera:
        assert vera.get(f"/notebooks/{notebook_id}").status_code == 404
        accepted = _accept(vera, viewer_link["token"])
        assert accepted.status_code == 200
        assert accepted.json() == {"notebook_id": notebook_id, "role": "viewer"}
        assert vera.get(f"/notebooks/{notebook_id}").json()["role"] == "viewer"
        assert [n["role"] for n in vera.get("/notebooks").json()] == ["viewer"]
        # Accepting again changes nothing.
        assert _accept(vera, viewer_link["token"]).json()["role"] == "viewer"


def test_accepting_never_lowers_a_role(owner: TestClient, clean_db: str) -> None:
    notebook_id = _notebook(owner)
    viewer_token = _link(owner, notebook_id, "viewer")["token"]
    editor_token = _link(owner, notebook_id, "editor")["token"]
    # The owner opening their own link stays owner.
    assert _accept(owner, viewer_token).json()["role"] == "owner"
    assert _accept(owner, editor_token).json()["role"] == "owner"
    with _user(clean_db, "Ed") as ed:
        assert _accept(ed, editor_token).json()["role"] == "editor"
        assert _accept(ed, viewer_token).json()["role"] == "editor"
        assert ed.get(f"/notebooks/{notebook_id}").json()["role"] == "editor"


def test_a_viewer_opening_an_editor_link_is_raised_and_reconnected(
    owner: TestClient, clean_db: str, listener: Listener
) -> None:
    notebook_id = _notebook(owner)
    with _user(clean_db, "Vera") as vera:
        _accept(vera, _link(owner, notebook_id, "viewer")["token"])
        assert listener.nothing_more()  # a new member has no live connection yet
        assert _accept(vera, _link(owner, notebook_id, "editor")["token"]).json() == {
            "notebook_id": notebook_id,
            "role": "editor",
        }
        expected = events.access_changed(uuid.UUID(notebook_id), uuid.UUID(_me(vera)))
        assert listener.take(1) == [compact(expected)]


def test_simultaneous_accepts_add_one_membership(owner: TestClient, clean_db: str) -> None:
    notebook_id = _notebook(owner)
    token = _link(owner, notebook_id, "editor")["token"]
    with _user(clean_db, "Ed") as ed:
        with ThreadPoolExecutor(max_workers=4) as pool:
            responses = list(pool.map(lambda _: _accept(ed, token), range(4)))
        assert [r.status_code for r in responses] == [200] * 4
        assert {r.json()["role"] for r in responses} == {"editor"}
    with sql_connection(clean_db) as conn:
        count = conn.execute(
            "SELECT count(*) FROM notebook_members WHERE notebook_id = %s", (notebook_id,)
        ).fetchone()
    assert count == (2,)


@pytest.mark.parametrize("token", ["unknown-token", "x" * 43, "é"])
def test_an_unknown_token_is_not_found(owner: TestClient, token: str) -> None:
    response = _accept(owner, token)
    assert response.status_code == 404
    assert response.json() == {
        "detail": {
            "kind": "not_found",
            "message": "This share link doesn't work. It may have been revoked.",
        }
    }


def test_a_revoked_link_stops_working_with_the_same_message(
    owner: TestClient, clean_db: str
) -> None:
    notebook_id = _notebook(owner)
    link = _link(owner, notebook_id, "viewer")
    unknown = _accept(owner, "never-issued").json()
    assert owner.delete(f"/notebooks/{notebook_id}/share-links/{link['id']}").status_code == 204
    assert owner.get(f"/notebooks/{notebook_id}/share-links").json() == []
    with _user(clean_db, "Mallory") as mallory:
        response = _accept(mallory, link["token"])
        assert response.status_code == 404
        assert response.json() == unknown
        assert mallory.get("/notebooks").json() == []
    again = owner.delete(f"/notebooks/{notebook_id}/share-links/{link['id']}")
    assert again.status_code == 404


def test_a_link_of_another_notebook_cannot_be_revoked_through_yours(owner: TestClient) -> None:
    mine = _notebook(owner, "mine")
    other = _notebook(owner, "other")
    link = _link(owner, other, "viewer")
    assert owner.delete(f"/notebooks/{mine}/share-links/{link['id']}").status_code == 404
    assert len(owner.get(f"/notebooks/{other}/share-links").json()) == 1


def test_a_deleted_notebook_takes_its_links_with_it(owner: TestClient, clean_db: str) -> None:
    notebook_id = _notebook(owner)
    token = _link(owner, notebook_id, "editor")["token"]
    assert owner.delete(f"/notebooks/{notebook_id}").status_code == 204
    with _user(clean_db, "Ed") as ed:
        assert _accept(ed, token).status_code == 404


def test_share_links_are_capped_per_notebook(owner: TestClient) -> None:
    notebook_id = _notebook(owner)
    for _ in range(MAX_SHARE_LINKS_PER_NOTEBOOK):
        _link(owner, notebook_id, "viewer")
    response = owner.post(f"/notebooks/{notebook_id}/share-links", json={"role": "viewer"})
    assert response.status_code == 409
    assert response.json()["detail"]["kind"] == "conflict"
    # Another notebook has its own allowance.
    _link(owner, _notebook(owner, "other"), "viewer")


def test_simultaneous_creates_cannot_exceed_the_cap(owner: TestClient) -> None:
    notebook_id = _notebook(owner)
    for _ in range(MAX_SHARE_LINKS_PER_NOTEBOOK - 2):
        _link(owner, notebook_id, "viewer")
    url = f"/notebooks/{notebook_id}/share-links"
    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(
            pool.map(lambda _: owner.post(url, json={"role": "viewer"}).status_code, range(6))
        )
    assert sorted(codes) == [201, 201, 409, 409, 409, 409]
    assert len(owner.get(url).json()) == MAX_SHARE_LINKS_PER_NOTEBOOK


@pytest.mark.parametrize("role", ["owner", "admin", ""])
def test_a_link_can_only_carry_editor_or_viewer(owner: TestClient, role: str) -> None:
    notebook_id = _notebook(owner)
    response = owner.post(f"/notebooks/{notebook_id}/share-links", json={"role": role})
    assert response.status_code == 422


def test_only_the_owner_manages_links(owner: TestClient, clean_db: str) -> None:
    notebook_id = _notebook(owner)
    link = _link(owner, notebook_id, "viewer")
    with _user(clean_db, "Ed") as ed, _user(clean_db, "Mallory") as mallory:
        _accept(ed, _link(owner, notebook_id, "editor")["token"])
        base = f"/notebooks/{notebook_id}/share-links"
        for client, code in [(ed, 403), (mallory, 404)]:
            assert client.post(base, json={"role": "viewer"}).status_code == code
            assert client.get(base).status_code == code
            assert client.delete(f"{base}/{link['id']}").status_code == code


# --- members ---------------------------------------------------------------------------


def _members(client: TestClient, notebook_id: str) -> list[dict[str, Any]]:
    response = client.get(f"/notebooks/{notebook_id}/members")
    assert response.status_code == 200, response.text
    members: list[dict[str, Any]] = response.json()
    return members


def test_any_member_sees_the_members_owner_first(owner: TestClient, clean_db: str) -> None:
    notebook_id = _notebook(owner)
    with _user(clean_db, "Zed") as zed, _user(clean_db, "Bea") as bea:
        _accept(zed, _link(owner, notebook_id, "editor")["token"])
        _accept(bea, _link(owner, notebook_id, "viewer")["token"])
        expected = [
            {"user_id": _me(owner), "name": "Ada", "role": "owner"},
            {"user_id": _me(zed), "name": "Zed", "role": "editor"},
            {"user_id": _me(bea), "name": "Bea", "role": "viewer"},
        ]
        assert _members(owner, notebook_id) == expected
        assert _members(bea, notebook_id) == expected
    with _user(clean_db, "Mallory") as mallory:
        assert mallory.get(f"/notebooks/{notebook_id}/members").status_code == 404


def test_the_owner_changes_a_role_and_the_sync_server_hears_of_it(
    owner: TestClient, clean_db: str, listener: Listener
) -> None:
    notebook_id = _notebook(owner)
    with _user(clean_db, "Vera") as vera:
        _accept(vera, _link(owner, notebook_id, "viewer")["token"])
        vera_id = _me(vera)
        url = f"/notebooks/{notebook_id}/members/{vera_id}"

        response = owner.patch(url, json={"role": "editor"})
        assert response.status_code == 200
        assert response.json() == {"user_id": vera_id, "name": "Vera", "role": "editor"}
        assert vera.get(f"/notebooks/{notebook_id}").json()["role"] == "editor"
        expected = compact(events.access_changed(uuid.UUID(notebook_id), uuid.UUID(vera_id)))
        assert listener.take(1) == [expected]

        # Setting the role it already has is not a change: no notification.
        assert owner.patch(url, json={"role": "editor"}).status_code == 200
        assert listener.nothing_more()


def test_role_changes_are_limited(owner: TestClient, clean_db: str) -> None:
    notebook_id = _notebook(owner)
    with _user(clean_db, "Ed") as ed, _user(clean_db, "Vera") as vera:
        _accept(ed, _link(owner, notebook_id, "editor")["token"])
        _accept(vera, _link(owner, notebook_id, "viewer")["token"])
        members = f"/notebooks/{notebook_id}/members"

        own = owner.patch(f"{members}/{_me(owner)}", json={"role": "viewer"})
        assert own.status_code == 403
        assert own.json()["detail"]["message"] == "The owner's role can't be changed."
        # Only one owner: "owner" isn't a role you can give.
        assert owner.patch(f"{members}/{_me(ed)}", json={"role": "owner"}).status_code == 422
        # Only the owner changes roles.
        assert ed.patch(f"{members}/{_me(vera)}", json={"role": "editor"}).status_code == 403
        assert ed.patch(f"{members}/{_me(ed)}", json={"role": "viewer"}).status_code == 403
        # Someone who isn't a member.
        missing = owner.patch(f"{members}/{uuid.uuid4()}", json={"role": "viewer"})
        assert missing.status_code == 404
        assert missing.json()["detail"]["message"] == "Member not found."
        assert [m["role"] for m in _members(owner, notebook_id)] == ["owner", "editor", "viewer"]


def test_the_owner_removes_a_member(owner: TestClient, clean_db: str, listener: Listener) -> None:
    notebook_id = _notebook(owner)
    with _user(clean_db, "Ed") as ed:
        _accept(ed, _link(owner, notebook_id, "editor")["token"])
        ed_id = _me(ed)
        assert owner.delete(f"/notebooks/{notebook_id}/members/{ed_id}").status_code == 204
        assert ed.get(f"/notebooks/{notebook_id}").status_code == 404
        expected = compact(events.access_changed(uuid.UUID(notebook_id), uuid.UUID(ed_id)))
        assert listener.take(1) == [expected]
        again = owner.delete(f"/notebooks/{notebook_id}/members/{ed_id}")
        assert again.status_code == 404


def test_members_can_leave_but_not_remove_others_and_the_owner_stays(
    owner: TestClient, clean_db: str, listener: Listener
) -> None:
    notebook_id = _notebook(owner)
    members = f"/notebooks/{notebook_id}/members"
    with _user(clean_db, "Ed") as ed, _user(clean_db, "Vera") as vera:
        _accept(ed, _link(owner, notebook_id, "editor")["token"])
        _accept(vera, _link(owner, notebook_id, "viewer")["token"])

        assert ed.delete(f"{members}/{_me(vera)}").status_code == 403
        assert vera.delete(f"{members}/{_me(owner)}").status_code == 403
        leave = owner.delete(f"{members}/{_me(owner)}")
        assert leave.status_code == 403
        assert leave.json()["detail"]["message"] == (
            "The owner can't leave the notebook. Delete it instead."
        )
        assert listener.nothing_more()

        vera_id = _me(vera)
        assert vera.delete(f"{members}/{vera_id}").status_code == 204
        assert vera.get(f"/notebooks/{notebook_id}").status_code == 404
        expected = compact(events.access_changed(uuid.UUID(notebook_id), uuid.UUID(vera_id)))
        assert listener.take(1) == [expected]
        assert [m["name"] for m in _members(owner, notebook_id)] == ["Ada", "Ed"]


def test_deleting_a_notebook_tells_the_sync_server(owner: TestClient, listener: Listener) -> None:
    notebook_id = _notebook(owner)
    assert owner.delete(f"/notebooks/{notebook_id}").status_code == 204
    assert listener.take(1) == [compact(events.notebook_deleted(uuid.UUID(notebook_id)))]


def test_refused_changes_send_nothing(owner: TestClient, clean_db: str, listener: Listener) -> None:
    notebook_id = _notebook(owner)
    with _user(clean_db, "Ed") as ed:
        _accept(ed, _link(owner, notebook_id, "editor")["token"])
        assert ed.delete(f"/notebooks/{notebook_id}").status_code == 403
        assert (
            owner.patch(
                f"/notebooks/{notebook_id}/members/{uuid.uuid4()}", json={"role": "viewer"}
            ).status_code
            == 404
        )
    assert listener.nothing_more()


def test_the_database_allows_one_owner_per_notebook(owner: TestClient, clean_db: str) -> None:
    notebook_id = _notebook(owner)
    with _user(clean_db, "Eve") as eve:
        eve_id = _me(eve)
    with pytest.raises(psycopg.errors.UniqueViolation):
        add_member(clean_db, notebook_id, eve_id, "owner")


# --- sync tickets -------------------------------------------------------------------------


def _b64decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def test_a_sync_ticket_has_exactly_the_shape_the_sync_server_verifies(
    owner: TestClient, clean_db: str
) -> None:
    notebook_id = _notebook(owner)
    with _user(clean_db, "Vera") as vera:
        _accept(vera, _link(owner, notebook_id, "viewer")["token"])
        before = int(time.time())
        response = vera.post(f"/notebooks/{notebook_id}/sync-ticket")
        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"ticket", "url", "role"}
        assert body["url"] == SYNC_URL
        assert body["role"] == "viewer"

        # The format, spelled out independently of tokens.sign: base64url
        # (no padding) of compact JSON, ".", base64url of
        # HMAC-SHA256(secret, "sync-ticket." + encoded payload).
        encoded, mac = body["ticket"].split(".")
        assert "=" not in encoded and "=" not in mac
        expected_mac = hmac.new(
            SYNC_SECRET.encode(), f"sync-ticket.{encoded}".encode(), hashlib.sha256
        ).digest()
        assert _b64decode(mac) == expected_mac
        payload = json.loads(_b64decode(encoded))
        assert set(payload) == {"u", "n", "nb", "r", "exp"}
        assert payload["u"] == _me(vera)
        assert payload["n"] == "Vera"
        assert payload["nb"] == notebook_id
        assert payload["r"] == "viewer"
        assert isinstance(payload["exp"], int)
        assert before + 59 <= payload["exp"] <= int(time.time()) + 60

        # And it verifies with the shared helper, for this purpose only.
        secret = SYNC_SECRET.encode()
        assert tokens.verify(body["ticket"], secret=secret, purpose="sync-ticket") == payload
        assert tokens.verify(body["ticket"], secret=secret, purpose="oauth-flow") is None
        assert (
            tokens.verify(body["ticket"], secret=TEST_AUTH_SECRET.encode(), purpose="sync-ticket")
            is None
        )


def test_the_ticket_carries_the_current_role(owner: TestClient) -> None:
    notebook_id = _notebook(owner)
    body = owner.post(f"/notebooks/{notebook_id}/sync-ticket").json()
    assert body["role"] == "owner"
    payload = tokens.verify(body["ticket"], secret=SYNC_SECRET.encode(), purpose="sync-ticket")
    assert payload is not None and payload["r"] == "owner"


def test_only_members_get_a_ticket(owner: TestClient, clean_db: str) -> None:
    notebook_id = _notebook(owner)
    with _user(clean_db, "Mallory") as mallory:
        response = mallory.post(f"/notebooks/{notebook_id}/sync-ticket")
    assert response.status_code == 404
    assert "ticket" not in response.text


def test_no_tickets_without_a_sync_secret(clean_db: str) -> None:
    with browser(create_app(auth_settings(database_url=clean_db))) as client:
        sign_in(client)
        notebook_id = _notebook(client)
        response = client.post(f"/notebooks/{notebook_id}/sync-ticket")
    assert response.status_code == 503
    assert response.json() == {
        "detail": {"kind": "unavailable", "message": "Live collaboration is not configured."}
    }


def test_the_sync_secret_must_be_long_and_its_own() -> None:
    with pytest.raises(ValidationError, match="at least 32"):
        Settings(sync_ticket_secret=SecretStr("short"))
    shared = SecretStr("z" * 40)
    with pytest.raises(ValidationError, match="must differ from AUTH_SECRET"):
        Settings(auth_secret=shared, sync_ticket_secret=shared)


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8020",
        "https://sync.example.com",
        "localhost:8020",
        "ws://",
        "ws://user:pw@localhost:8020",
        "ws://localhost:8020/?token=x",
        "wss://sync.example.com/#frag",
    ],
)
def test_the_sync_url_must_be_a_plain_websocket_url(url: str) -> None:
    with pytest.raises(ValidationError, match="SYNC_PUBLIC_URL"):
        Settings(sync_public_url=url)


def test_the_sync_url_defaults_to_the_local_sync_server_and_drops_a_trailing_slash() -> None:
    assert Settings().sync_public_url == "ws://localhost:8020"
    assert Settings(sync_public_url="wss://sync.example.com/").sync_public_url == (
        "wss://sync.example.com"
    )


def test_a_full_notebook_refuses_new_members_but_not_existing_ones(
    owner: TestClient, clean_db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sharing, "MEMBERS_LIMIT", 2)  # the owner plus one
    notebook_id = _notebook(owner)
    link = _link(owner, notebook_id, "editor")
    with _user(clean_db, "Vera") as vera, _user(clean_db, "Ed") as ed:
        assert _accept(vera, link["token"]).status_code == 200
        refused = _accept(ed, link["token"])
        assert refused.status_code == 409
        assert refused.json()["detail"]["message"] == "This notebook has reached its member limit."
        assert ed.get(f"/notebooks/{notebook_id}").status_code == 404
        # Someone already in can still open a link (it's not a new member).
        assert _accept(vera, link["token"]).status_code == 200
