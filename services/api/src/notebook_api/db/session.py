"""The async engine and per-request sessions."""

from collections.abc import AsyncIterator

from fastapi import HTTPException, Request
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


def create_engine(database_url: str) -> AsyncEngine:
    # pool_pre_ping: survive Postgres restarts without a burst of errors.
    return create_async_engine(database_url, pool_pre_ping=True)


def make_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    # expire_on_commit=False: objects stay readable after commit, for responses.
    return async_sessionmaker(engine, expire_on_commit=False)


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: one session per request."""
    sessions: async_sessionmaker[AsyncSession] | None = request.app.state.sessions
    if sessions is None:
        raise HTTPException(
            status_code=503,
            detail={"kind": "unavailable", "message": "The database is not configured."},
        )
    async with sessions() as session:
        yield session
