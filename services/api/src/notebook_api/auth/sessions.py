"""Server-side sessions: a random token in the browser, only its hash in Postgres.

The cookie holds 32 random bytes. The database stores SHA-256 of them, so
someone who reads the sessions table (a backup, a leaked dump) can't use
what they find: turning a hash back into a working token is infeasible.
A plain hash (not bcrypt) is right here, because the token is random and
long, not a guessable password.

Signing out deletes the row, which ends the session at once everywhere,
unlike a self-contained token that stays valid until it expires.
"""

import hashlib
import secrets
import uuid
from datetime import timedelta
from typing import Annotated

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from notebook_api.config import Settings
from notebook_api.db.models import AuthSession, User, UserIdentity
from notebook_api.db.session import get_session


def session_cookie_name(settings: Settings) -> str:
    """The session cookie's name.

    App-specific, because cookies aren't separated by port: another app on
    localhost using a cookie named "session" would overwrite ours. With
    HTTPS it also gets the __Host- prefix, which browsers only accept on a
    Secure cookie with Path=/ and no Domain: a sibling subdomain then can't
    plant its own value for it (cookie tossing).
    """
    return "__Host-notebook_session" if settings.auth_cookie_secure else "notebook_session"


def hash_token(token: str) -> bytes:
    return hashlib.sha256(token.encode("ascii", errors="replace")).digest()


async def find_or_create_user(
    session: AsyncSession, provider: str, subject: str, name: str
) -> User:
    """The user for this provider identity, creating it on first sign-in.

    The display name is refreshed from the provider on every sign-in.
    Two first sign-ins racing for the same identity can't create two users:
    the identity insert is ON CONFLICT DO NOTHING, and the loser rolls back
    its new user and uses the winner's.
    """
    existing = await session.scalar(
        select(User)
        .join(UserIdentity, UserIdentity.user_id == User.id)
        .where(UserIdentity.provider == provider, UserIdentity.subject == subject)
    )
    if existing is not None:
        existing.name = name
        await session.flush()
        return existing

    user = User(name=name)
    session.add(user)
    await session.flush()
    claimed = await session.scalar(
        pg_insert(UserIdentity)
        .values(provider=provider, subject=subject, user_id=user.id)
        .on_conflict_do_nothing()
        .returning(UserIdentity.user_id)
    )
    if claimed is None:  # another sign-in created this identity first
        await session.rollback()
        winner = await session.scalar(
            select(User)
            .join(UserIdentity, UserIdentity.user_id == User.id)
            .where(UserIdentity.provider == provider, UserIdentity.subject == subject)
        )
        if winner is None:  # pragma: no cover - the winner's row is committed
            raise RuntimeError("identity conflict without a winning row")
        return winner
    return user


async def start_session(session: AsyncSession, user_id: uuid.UUID, days: int) -> str:
    """Create a session for `user_id` and return its token (for the cookie only).

    Also deletes this user's expired sessions, so the table doesn't grow
    without bound for people who never sign out.
    """
    token = secrets.token_urlsafe(32)
    await session.execute(
        delete(AuthSession).where(
            AuthSession.user_id == user_id, AuthSession.expires_at <= func.now()
        )
    )
    session.add(
        AuthSession(
            token_hash=hash_token(token),
            user_id=user_id,
            expires_at=func.now() + timedelta(days=days),
        )
    )
    await session.flush()
    return token


async def end_session(session: AsyncSession, token: str) -> None:
    await session.execute(delete(AuthSession).where(AuthSession.token_hash == hash_token(token)))


def set_session_cookie(response: Response, token: str, settings: Settings) -> None:
    response.set_cookie(
        session_cookie_name(settings),
        token,
        max_age=settings.session_days * 86_400,
        path="/",
        httponly=True,  # page scripts (and so XSS) can't read it
        secure=settings.auth_cookie_secure,
        # Lax: sent on top-level navigations and same-site requests, never on
        # cross-site subrequests, so another site can't spend the session.
        samesite="lax",
    )


def clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        session_cookie_name(settings),
        path="/",
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite="lax",
    )


def _unauthenticated() -> HTTPException:
    return HTTPException(
        status_code=401, detail={"kind": "unauthenticated", "message": "Please sign in."}
    )


async def current_user(
    request: Request, session: Annotated[AsyncSession, Depends(get_session)]
) -> User:
    """FastAPI dependency: the signed-in user, or 401."""
    token = request.cookies.get(session_cookie_name(request.app.state.settings))
    if not token or len(token) > 200:
        raise _unauthenticated()
    user = await session.scalar(
        select(User)
        .join(AuthSession, AuthSession.user_id == User.id)
        .where(AuthSession.token_hash == hash_token(token), AuthSession.expires_at > func.now())
    )
    if user is None:
        raise _unauthenticated()
    return user


CurrentUser = Annotated[User, Depends(current_user)]
