"""Postgres NOTIFY messages that tell the sync server what changed.

The sync server LISTENs on one channel and reacts: it writes a cell's
running state and latest run into the shared document, and closes the
connections of people whose access changed or whose notebook is gone.

Every message is sent with `pg_notify` inside the same transaction as the
change it describes. Postgres delivers notifications only when that
transaction commits, and drops them if it rolls back, so the sync server
never hears about a change that didn't happen, and never hears about it
before the change is visible to its own queries.

Payloads are compact JSON. Postgres refuses payloads of 8000 bytes or more,
which would fail the whole transaction, so each one is checked here first
(they are a few hundred bytes: IDs plus a display name of at most 200
characters).
"""

import json
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

CHANNEL = "notebook_events"
MAX_PAYLOAD_BYTES = 8000


def encode(event: dict[str, Any]) -> str:
    """The payload text: compact, ASCII-only JSON, below Postgres's size limit."""
    payload = json.dumps(event, separators=(",", ":"))
    if len(payload.encode("utf-8")) >= MAX_PAYLOAD_BYTES:
        raise ValueError(f"notification payload is too large ({event.get('type')})")
    return payload


async def notify(session: AsyncSession, event: dict[str, Any]) -> None:
    """Queue `event` in the session's current transaction; it's sent on commit."""
    await session.execute(select(func.pg_notify(CHANNEL, encode(event))))


def run_started(
    notebook_id: uuid.UUID,
    cell_id: str,
    execution_id: uuid.UUID,
    user_name: str,
    started_at: datetime,
) -> dict[str, Any]:
    return {
        "type": "run_started",
        "notebook_id": str(notebook_id),
        "cell_id": cell_id,
        "execution_id": str(execution_id),
        "user_name": user_name,
        "started_at": started_at.isoformat(),
    }


def run_finished(
    notebook_id: uuid.UUID, cell_id: str, execution_id: uuid.UUID, run_id: uuid.UUID | None
) -> dict[str, Any]:
    """`run_id` is None when the service failed and nothing was stored."""
    return {
        "type": "run_finished",
        "notebook_id": str(notebook_id),
        "cell_id": cell_id,
        "execution_id": str(execution_id),
        "run_id": None if run_id is None else str(run_id),
    }


def access_changed(notebook_id: uuid.UUID, user_id: uuid.UUID) -> dict[str, Any]:
    return {"type": "access_changed", "notebook_id": str(notebook_id), "user_id": str(user_id)}


def notebook_deleted(notebook_id: uuid.UUID) -> dict[str, Any]:
    return {"type": "notebook_deleted", "notebook_id": str(notebook_id)}
