"""Notebook routes: the notebooks themselves and their cell runs.

A notebook's content (its Yjs document) is never read or written here: the
sync server is its only reader and writer.

Every route needs a signed-in user who is a member of the notebook; see
access.py for what each role may do.
"""

import uuid
from datetime import datetime
from typing import Annotated, Literal, cast

from fastapi import APIRouter, HTTPException, Path, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete as sa_delete
from sqlalchemy import select

from notebook_api import events
from notebook_api.auth.sessions import CurrentUser
from notebook_api.db.models import CellRun, Notebook, NotebookMember
from notebook_api.notebooks.access import (
    NotebookId,
    Role,
    Session,
    membership,
    not_found,
)
from notebook_api.notebooks.executions import Executions, Failed, Gone
from notebook_api.query.engine import QueryResult
from notebook_api.query.validate import MAX_SQL_CHARS

router = APIRouter(prefix="/notebooks")

# Cell IDs come from the client (they live in the Yjs document), so they're
# restricted to a safe, bounded alphabet.
CellId = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{1,64}$")]

# GET /notebooks returns at most this many, most recently updated first.
# There's no pagination yet.
LIST_LIMIT = 100


class NotebookCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class NotebookUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class NotebookOut(BaseModel):
    id: uuid.UUID
    title: str
    created_at: datetime
    updated_at: datetime
    role: Role  # the signed-in user's role in this notebook


class RunCreate(BaseModel):
    sql: str = Field(min_length=1, max_length=MAX_SQL_CHARS)


class RunError(BaseModel):
    kind: Literal["rejected", "error", "timeout"]
    message: str


class RunOut(BaseModel):
    id: uuid.UUID
    cell_id: str
    sql: str
    status: Literal["ok", "error"]
    result: QueryResult | None
    error: RunError | None
    created_at: datetime


def _out(notebook: Notebook, role: Role) -> NotebookOut:
    return NotebookOut(
        id=notebook.id,
        title=notebook.title,
        created_at=notebook.created_at,
        updated_at=notebook.updated_at,
        role=role,
    )


@router.post("", status_code=201)
async def create_notebook(body: NotebookCreate, user: CurrentUser, session: Session) -> NotebookOut:
    notebook = Notebook(title=body.title)
    session.add(notebook)
    await session.flush()
    session.add(NotebookMember(notebook_id=notebook.id, user_id=user.id, role="owner"))
    await session.commit()
    await session.refresh(notebook)
    return _out(notebook, "owner")


@router.get("")
async def list_notebooks(user: CurrentUser, session: Session) -> list[NotebookOut]:
    rows = await session.execute(
        select(Notebook, NotebookMember.role)
        .join(NotebookMember, NotebookMember.notebook_id == Notebook.id)
        .where(NotebookMember.user_id == user.id)
        .order_by(Notebook.updated_at.desc())
        .limit(LIST_LIMIT)
    )
    return [_out(notebook, cast(Role, role)) for notebook, role in rows]


@router.get("/{notebook_id}")
async def get_notebook(notebook_id: NotebookId, user: CurrentUser, session: Session) -> NotebookOut:
    return _out(*await membership(session, notebook_id, user.id))


@router.patch("/{notebook_id}")
async def update_notebook(
    notebook_id: NotebookId, body: NotebookUpdate, user: CurrentUser, session: Session
) -> NotebookOut:
    notebook, role = await membership(session, notebook_id, user.id, "editor")
    notebook.title = body.title
    await session.commit()
    await session.refresh(notebook)
    return _out(notebook, role)


@router.delete("/{notebook_id}", status_code=204)
async def delete_notebook(notebook_id: NotebookId, user: CurrentUser, session: Session) -> Response:
    await membership(session, notebook_id, user.id, "owner")
    # The DELETE locks the notebook row first and then cascades to its
    # snapshot, runs, members, share links and execution locks (ON DELETE
    # CASCADE): the same order every other writer uses (see lock_notebook).
    # The sync server hears about it when this commits, and disconnects everyone.
    deleted = await session.scalar(
        sa_delete(Notebook).where(Notebook.id == notebook_id).returning(Notebook.id)
    )
    if deleted is None:  # deleted by another request a moment ago
        raise not_found()
    await events.notify(session, events.notebook_deleted(notebook_id))
    await session.commit()
    return Response(status_code=204)


# --- Shared cell runs -----------------------------------------------------


@router.post(
    "/{notebook_id}/cells/{cell_id}/runs",
    status_code=201,
    responses={200: {"description": "Joined a run of this cell already in flight"}},
)
async def run_cell(
    notebook_id: NotebookId,
    cell_id: CellId,
    body: RunCreate,
    request: Request,
    response: Response,
    user: CurrentUser,
    session: Session,
) -> RunOut:
    """Run a cell's SQL and store the outcome for everyone to see.

    One execution per cell at a time (see executions.py). 201: this request
    ran the query. 200: the cell was already running, so this request
    waited for that execution and returns its run, whose SQL may differ from
    the SQL sent here. 503: the query service failed (busy, crashed) and
    nothing was stored; the client can retry.

    No database transaction stays open while the query runs (which can take
    many seconds): the membership check ends its transaction first, and the
    lock and the run are written in short transactions of their own.
    Otherwise every running query would hold a pooled connection.
    """
    await membership(session, notebook_id, user.id, "editor")
    executions: Executions | None = request.app.state.executions
    if executions is None:
        raise HTTPException(
            status_code=503,
            detail={"kind": "unavailable", "message": "The query engine is not configured."},
        )
    user_id, user_name = user.id, user.name
    # End the read transaction and release the connection. (Rollback also
    # expires loaded objects, so nothing below reads `user` or the notebook.)
    await session.rollback()

    outcome, joined = await executions.run(notebook_id, cell_id, body.sql, user_id, user_name)
    if isinstance(outcome, Gone):
        raise not_found()
    if isinstance(outcome, Failed):
        raise HTTPException(
            status_code=503, detail={"kind": outcome.kind, "message": outcome.message}
        )
    if joined:
        response.status_code = 200
    return RunOut.model_validate(outcome.run, from_attributes=True)


@router.get("/{notebook_id}/runs/{run_id}")
async def get_run(
    notebook_id: NotebookId, run_id: uuid.UUID, user: CurrentUser, session: Session
) -> RunOut:
    await membership(session, notebook_id, user.id)
    run = await session.get(CellRun, run_id)
    if run is None or run.notebook_id != notebook_id:
        raise HTTPException(
            status_code=404, detail={"kind": "not_found", "message": "Run not found."}
        )
    return RunOut.model_validate(run, from_attributes=True)
