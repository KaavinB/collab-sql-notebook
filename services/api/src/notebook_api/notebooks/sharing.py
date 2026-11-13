"""Sharing: share links, members, and tickets for the sync server.

POST   /notebooks/{id}/share-links            owner: create a link (the token is shown once)
GET    /notebooks/{id}/share-links            owner: list links (never their tokens)
DELETE /notebooks/{id}/share-links/{link_id}  owner: revoke a link
POST   /share-links/accept                    anyone signed in: join through a link
GET    /notebooks/{id}/members                any member: who has access
PATCH  /notebooks/{id}/members/{user_id}      owner: change someone's role
DELETE /notebooks/{id}/members/{user_id}      owner: remove someone; anyone else: leave
POST   /notebooks/{id}/sync-ticket            any member: a ticket to connect to the sync server

Every change to someone's access sends NOTIFY `access_changed` in the same
transaction, so the sync server drops that person's live connections once
it commits; they reconnect with a fresh ticket, which carries their new
role, or are refused if they no longer have access.
"""

import secrets
import uuid
from datetime import datetime
from typing import Literal, cast

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import case, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from notebook_api import events
from notebook_api.auth import tokens
from notebook_api.auth.sessions import CurrentUser, hash_token
from notebook_api.config import Settings
from notebook_api.db.models import NotebookMember, ShareLink, User
from notebook_api.notebooks.access import (
    RANK,
    NotebookId,
    Role,
    Session,
    forbidden,
    lock_notebook,
    membership,
    not_found,
)

members_router = APIRouter(prefix="/notebooks")
share_links_router = APIRouter(prefix="/share-links")

# Links are for handing to a few people, not a directory. A cap keeps a
# notebook's list readable and bounds what a compromised owner account (or a
# buggy client in a loop) can create. Revoke one to make room.
MAX_SHARE_LINKS_PER_NOTEBOOK = 20
# Long enough for the browser to open the WebSocket (and retry once), short
# enough that a leaked ticket is soon useless. The sync server checks access
# again whenever it hears `access_changed`, so a ticket outliving a change
# of role doesn't matter.
SYNC_TICKET_TTL_SECONDS = 60
SYNC_TICKET_PURPOSE = "sync-ticket"
# At most this many members per notebook. Accepting a share link is refused
# past it, so GET /members (which returns at most this many) never cuts the
# list short. Two joins committing at the same moment can each pass the
# check, so the real ceiling is this plus the number of simultaneous joins.
MEMBERS_LIMIT = 500

SharedRole = Literal["editor", "viewer"]


class ShareLinkCreate(BaseModel):
    role: SharedRole


class ShareLinkOut(BaseModel):
    id: uuid.UUID
    role: SharedRole
    created_at: datetime


class ShareLinkCreated(ShareLinkOut):
    # The only time the raw token leaves the server; only its hash is stored.
    token: str


class ShareLinkAccept(BaseModel):
    # Real tokens are 43 characters; anything longer can't be one.
    token: str = Field(min_length=1, max_length=200)


class ShareLinkAccepted(BaseModel):
    notebook_id: uuid.UUID
    role: Role  # the role the user has now, which may be higher than the link's


class MemberOut(BaseModel):
    user_id: uuid.UUID
    name: str
    role: Role


class MemberUpdate(BaseModel):
    # Never "owner": a notebook has exactly one owner.
    role: SharedRole


class SyncTicketOut(BaseModel):
    ticket: str
    url: str
    role: Role


def _link_not_found() -> HTTPException:
    # One message for unknown, revoked and malformed tokens alike.
    return HTTPException(
        status_code=404,
        detail={
            "kind": "not_found",
            "message": "This share link doesn't work. It may have been revoked.",
        },
    )


def _member_not_found() -> HTTPException:
    return HTTPException(
        status_code=404, detail={"kind": "not_found", "message": "Member not found."}
    )


# --- share links ------------------------------------------------------------


@members_router.post("/{notebook_id}/share-links", status_code=201)
async def create_share_link(
    notebook_id: NotebookId, body: ShareLinkCreate, user: CurrentUser, session: Session
) -> ShareLinkCreated:
    await membership(session, notebook_id, user.id, "owner")
    # Exclusive, so two creates can't both count 19 links and both insert.
    if not await lock_notebook(session, notebook_id, exclusive=True):
        raise not_found()
    count = await session.scalar(
        select(func.count()).select_from(ShareLink).where(ShareLink.notebook_id == notebook_id)
    )
    if (count or 0) >= MAX_SHARE_LINKS_PER_NOTEBOOK:
        raise HTTPException(
            status_code=409,
            detail={
                "kind": "conflict",
                "message": f"A notebook can have at most {MAX_SHARE_LINKS_PER_NOTEBOOK} "
                "share links. Revoke one first.",
            },
        )
    # 32 random bytes, like session tokens; stored only as SHA-256.
    token = secrets.token_urlsafe(32)
    link = ShareLink(
        notebook_id=notebook_id,
        token_hash=hash_token(token),
        role=body.role,
        created_by=user.id,
    )
    session.add(link)
    await session.commit()
    await session.refresh(link)
    return ShareLinkCreated(id=link.id, role=body.role, created_at=link.created_at, token=token)


@members_router.get("/{notebook_id}/share-links")
async def list_share_links(
    notebook_id: NotebookId, user: CurrentUser, session: Session
) -> list[ShareLinkOut]:
    await membership(session, notebook_id, user.id, "owner")
    links = await session.scalars(
        select(ShareLink)
        .where(ShareLink.notebook_id == notebook_id)
        .order_by(ShareLink.created_at, ShareLink.id)
    )
    return [
        ShareLinkOut(id=link.id, role=cast(SharedRole, link.role), created_at=link.created_at)
        for link in links
    ]


@members_router.delete("/{notebook_id}/share-links/{link_id}", status_code=204)
async def revoke_share_link(
    notebook_id: NotebookId, link_id: uuid.UUID, user: CurrentUser, session: Session
) -> Response:
    await membership(session, notebook_id, user.id, "owner")
    deleted = await session.scalar(
        delete(ShareLink)
        .where(ShareLink.id == link_id, ShareLink.notebook_id == notebook_id)
        .returning(ShareLink.id)
    )
    if deleted is None:
        raise HTTPException(
            status_code=404, detail={"kind": "not_found", "message": "Share link not found."}
        )
    await session.commit()
    return Response(status_code=204)


@share_links_router.post("/accept")
async def accept_share_link(
    body: ShareLinkAccept, user: CurrentUser, session: Session
) -> ShareLinkAccepted:
    """Join a notebook through a share link.

    Never lowers a role: the owner stays owner, and an editor who opens a
    viewer link stays an editor. A viewer who opens an editor link becomes
    an editor. Safe to call twice, or at the same moment from two tabs.
    """
    token_hash = hash_token(body.token)
    notebook_id = await session.scalar(
        select(ShareLink.notebook_id).where(ShareLink.token_hash == token_hash)
    )
    if notebook_id is None:
        raise _link_not_found()
    # Lock order: the notebook row, then the link row. Locking the link
    # (FOR SHARE) makes a revoke that is committing right now either finish
    # first (the link is gone: 404) or wait until this join has committed.
    if not await lock_notebook(session, notebook_id):
        raise _link_not_found()
    link_role = await session.scalar(
        select(ShareLink.role).where(ShareLink.token_hash == token_hash).with_for_update(read=True)
    )
    if link_role is None:
        raise _link_not_found()
    already_member = await session.scalar(
        select(NotebookMember.role).where(
            NotebookMember.notebook_id == notebook_id, NotebookMember.user_id == user.id
        )
    )
    if already_member is None:
        members = await session.scalar(
            select(func.count())
            .select_from(NotebookMember)
            .where(NotebookMember.notebook_id == notebook_id)
        )
        if (members or 0) >= MEMBERS_LIMIT:
            raise HTTPException(
                status_code=409,
                detail={
                    "kind": "conflict",
                    "message": "This notebook has reached its member limit.",
                },
            )

    role = await _join(session, notebook_id, user.id, cast(SharedRole, link_role))
    await session.commit()
    return ShareLinkAccepted(notebook_id=notebook_id, role=role)


async def _join(
    session: AsyncSession, notebook_id: uuid.UUID, user_id: uuid.UUID, link_role: SharedRole
) -> Role:
    """Add the membership, or raise an existing one to `link_role`; never lower it.

    Two accepts at once (two tabs) can't collide: the insert is ON CONFLICT
    DO NOTHING, and the second one waits for the first to commit.
    """
    member = (NotebookMember.notebook_id == notebook_id, NotebookMember.user_id == user_id)
    # Retried only if the membership is removed between two statements below.
    for _ in range(3):
        added = await session.scalar(
            pg_insert(NotebookMember)
            .values(notebook_id=notebook_id, user_id=user_id, role=link_role)
            .on_conflict_do_nothing()
            .returning(NotebookMember.role)
        )
        if added is not None:
            return cast(Role, added)
        raised = await session.scalar(
            update(NotebookMember)
            .where(*member, case(RANK, value=NotebookMember.role) < RANK[link_role])
            .values(role=link_role)
            .returning(NotebookMember.role)
        )
        if raised is not None:
            # Their live connections still carry the old role; the sync
            # server reconnects them with the new one.
            await events.notify(session, events.access_changed(notebook_id, user_id))
            return cast(Role, raised)
        current = await session.scalar(select(NotebookMember.role).where(*member))
        if current is not None:
            return cast(Role, current)
    raise HTTPException(  # pragma: no cover - needs three removals racing one accept
        status_code=409,
        detail={"kind": "conflict", "message": "Your access changed meanwhile. Try again."},
    )


# --- members ------------------------------------------------------------------


@members_router.get("/{notebook_id}/members")
async def list_members(
    notebook_id: NotebookId, user: CurrentUser, session: Session
) -> list[MemberOut]:
    await membership(session, notebook_id, user.id)
    rows = await session.execute(
        select(NotebookMember.user_id, User.name, NotebookMember.role)
        .join(User, User.id == NotebookMember.user_id)
        .where(NotebookMember.notebook_id == notebook_id)
        # Owner first, then editors, then viewers; by name within each.
        .order_by(case(RANK, value=NotebookMember.role).desc(), User.name, User.id)
        .limit(MEMBERS_LIMIT)
    )
    return [
        MemberOut(user_id=user_id, name=name, role=cast(Role, role)) for user_id, name, role in rows
    ]


@members_router.patch("/{notebook_id}/members/{user_id}")
async def update_member(
    notebook_id: NotebookId,
    user_id: uuid.UUID,
    body: MemberUpdate,
    user: CurrentUser,
    session: Session,
) -> MemberOut:
    await membership(session, notebook_id, user.id, "owner")
    if user_id == user.id:
        # The only owner is the caller, so this is the owner's own role.
        raise forbidden("The owner's role can't be changed.")
    member = (NotebookMember.notebook_id == notebook_id, NotebookMember.user_id == user_id)
    changed = await session.scalar(
        update(NotebookMember)
        # Never the owner's row (also covered by the check above, since a
        # notebook has exactly one owner, which the database enforces).
        .where(*member, NotebookMember.role != "owner", NotebookMember.role != body.role)
        .values(role=body.role)
        .returning(NotebookMember.user_id)
    )
    if changed is not None:
        await events.notify(session, events.access_changed(notebook_id, user_id))
    else:
        current = await session.scalar(select(NotebookMember.role).where(*member))
        if current is None:
            raise _member_not_found()
        if current == "owner":  # pragma: no cover - the caller is the only owner
            raise forbidden("The owner's role can't be changed.")
    name = await session.scalar(select(User.name).where(User.id == user_id))
    await session.commit()
    return MemberOut(user_id=user_id, name=name or "", role=body.role)


@members_router.delete("/{notebook_id}/members/{user_id}", status_code=204)
async def remove_member(
    notebook_id: NotebookId, user_id: uuid.UUID, user: CurrentUser, session: Session
) -> Response:
    """The owner removes anyone else; any other member may remove themself (leave).

    The owner can't leave: a notebook always has its owner. They delete it instead.
    """
    _, role = await membership(session, notebook_id, user.id)
    if user_id == user.id:
        if role == "owner":
            raise forbidden("The owner can't leave the notebook. Delete it instead.")
    elif role != "owner":
        raise forbidden("Only the owner can remove other members.")
    removed = await session.scalar(
        delete(NotebookMember)
        .where(
            NotebookMember.notebook_id == notebook_id,
            NotebookMember.user_id == user_id,
            # Defense in depth: the checks above already exclude the owner.
            NotebookMember.role != "owner",
        )
        .returning(NotebookMember.user_id)
    )
    if removed is None:
        raise _member_not_found()
    await events.notify(session, events.access_changed(notebook_id, user_id))
    await session.commit()
    return Response(status_code=204)


# --- sync tickets --------------------------------------------------------------


@members_router.post("/{notebook_id}/sync-ticket")
async def create_sync_ticket(
    notebook_id: NotebookId, request: Request, user: CurrentUser, session: Session
) -> SyncTicketOut:
    """A short-lived ticket the browser presents to the sync server.

    The sync server can't read the session cookie (it's another origin and
    shouldn't handle cookies at all), so the API vouches for the user here:
    who they are, which notebook, and their role in it, signed with the
    secret the two servers share.
    """
    settings: Settings = request.app.state.settings
    if settings.sync_ticket_secret is None:
        raise HTTPException(
            status_code=503,
            detail={"kind": "unavailable", "message": "Live collaboration is not configured."},
        )
    _, role = await membership(session, notebook_id, user.id)
    ticket = tokens.sign(
        {"u": str(user.id), "n": user.name, "nb": str(notebook_id), "r": role},
        secret=settings.sync_ticket_secret.get_secret_value().encode("utf-8"),
        purpose=SYNC_TICKET_PURPOSE,
        ttl_seconds=SYNC_TICKET_TTL_SECONDS,
    )
    return SyncTicketOut(ticket=ticket, url=settings.sync_public_url, role=role)
