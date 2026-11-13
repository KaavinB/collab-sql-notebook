"""Notebook routes.

Every route needs a signed-in user who is a member of the notebook:
- viewer: read the notebook, its document and its runs
- editor: also rename it, save its document and run cells
- owner: also delete it

A notebook you aren't a member of answers 404, exactly like one that
doesn't exist, so IDs can't be probed to learn which notebooks exist.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response
from psycopg.errors import ForeignKeyViolation
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from notebook_api.auth.sessions import CurrentUser
from notebook_api.db.models import CellRun, Notebook, NotebookMember, NotebookSnapshot
from notebook_api.db.session import get_session
from notebook_api.query.engine import QueryResult
from notebook_api.query.runner import QueryFailedError, QueryRunner
from notebook_api.query.validate import MAX_SQL_CHARS, QueryRejectedError

router = APIRouter(prefix="/notebooks")

Session = Annotated[AsyncSession, Depends(get_session)]
NotebookId = Annotated[uuid.UUID, Path()]
# Cell IDs come from the client (they live in the Yjs document), so they're
# restricted to a safe, bounded alphabet.
CellId = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{1,64}$")]

# Older runs of a cell are pruned. A few are kept, not just the latest, so a
# client that is a moment behind can still load the run it was told about.
RUNS_KEPT_PER_CELL = 3
# GET /notebooks returns at most this many, most recently updated first.
# There's no pagination yet.
LIST_LIMIT = 100

Role = Literal["owner", "editor", "viewer"]
_RANK: dict[str, int] = {"viewer": 0, "editor": 1, "owner": 2}


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


def _not_found() -> HTTPException:
    return HTTPException(
        status_code=404, detail={"kind": "not_found", "message": "Notebook not found."}
    )


async def _membership(
    session: AsyncSession, notebook_id: uuid.UUID, user_id: uuid.UUID, at_least: Role = "viewer"
) -> tuple[Notebook, Role]:
    """The notebook and the user's role in it.

    404 if it doesn't exist or the user isn't a member; 403 if the user is
    a member whose role is below `at_least`.
    """
    row = (
        await session.execute(
            select(Notebook, NotebookMember.role)
            .join(NotebookMember, NotebookMember.notebook_id == Notebook.id)
            .where(Notebook.id == notebook_id, NotebookMember.user_id == user_id)
        )
    ).first()
    if row is None:
        raise _not_found()
    notebook = row[0]
    # The ck_notebook_members_role check constraint limits the column to Role.
    role = cast(Role, row[1])
    if _RANK[role] < _RANK[at_least]:
        raise HTTPException(
            status_code=403,
            detail={
                "kind": "forbidden",
                "message": f"You need {at_least} access to do that. Your role is {role}.",
            },
        )
    return notebook, role


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
    return _out(*await _membership(session, notebook_id, user.id))


@router.patch("/{notebook_id}")
async def update_notebook(
    notebook_id: NotebookId, body: NotebookUpdate, user: CurrentUser, session: Session
) -> NotebookOut:
    notebook, role = await _membership(session, notebook_id, user.id, "editor")
    notebook.title = body.title
    await session.commit()
    await session.refresh(notebook)
    return _out(notebook, role)


@router.delete("/{notebook_id}", status_code=204)
async def delete_notebook(notebook_id: NotebookId, user: CurrentUser, session: Session) -> Response:
    notebook, _ = await _membership(session, notebook_id, user.id, "owner")
    # The snapshot, runs and memberships go with it (ON DELETE CASCADE).
    await session.delete(notebook)
    await session.commit()
    return Response(status_code=204)


# --- Yjs snapshot ---------------------------------------------------------

_YJS_MEDIA_TYPE = "application/octet-stream"


@router.get("/{notebook_id}/snapshot")
async def get_snapshot(notebook_id: NotebookId, user: CurrentUser, session: Session) -> Response:
    """The notebook's Yjs state, or 204 if nothing has been saved yet."""
    await _membership(session, notebook_id, user.id)
    snapshot = await session.get(NotebookSnapshot, notebook_id)
    if snapshot is None:
        return Response(status_code=204)
    return Response(content=snapshot.state, media_type=_YJS_MEDIA_TYPE)


@router.put("/{notebook_id}/snapshot", status_code=204)
async def put_snapshot(
    notebook_id: NotebookId, request: Request, user: CurrentUser, session: Session
) -> Response:
    """Replace the notebook's Yjs state with the request body.

    The body is `Y.encodeStateAsUpdate(doc)` from the client. The server
    doesn't decode it in Phase 1. Last write wins, which is fine with one
    writer; Phase 2 moves persistence to the sync server.
    """
    # BodyLimitMiddleware enforces the snapshot byte cap before any route or
    # database dependency runs, including for uploads without Content-Length.
    await _membership(session, notebook_id, user.id, "editor")
    state = await request.body()
    if not state:
        raise HTTPException(
            status_code=400, detail={"kind": "invalid", "message": "Empty snapshot."}
        )
    # Lock order matters. DELETE /notebooks locks the notebook row, then (by
    # ON DELETE CASCADE) the snapshot row. Saving takes them in the same order
    # (notebook first, then snapshot), so the two can't deadlock. Updating
    # the notebook row first also serves as the existence check: if the
    # notebook was just deleted, no row comes back and this is a clean 404.
    touched = await session.execute(
        update(Notebook)
        .where(Notebook.id == notebook_id)
        # Saving content counts as updating the notebook ("recent" ordering).
        .values(updated_at=func.now())
        .returning(Notebook.id)
    )
    if touched.first() is None:
        await session.rollback()
        raise _not_found()
    # One atomic upsert: two first saves at the same moment (two tabs opening a
    # new notebook) can't both try to INSERT and collide on the primary key.
    upsert = pg_insert(NotebookSnapshot).values(notebook_id=notebook_id, state=state)
    await session.execute(
        upsert.on_conflict_do_update(
            index_elements=[NotebookSnapshot.notebook_id],
            set_={"state": upsert.excluded.state, "updated_at": func.now()},
        )
    )
    await session.commit()
    return Response(status_code=204)


# --- Shared cell runs -----------------------------------------------------


@router.post("/{notebook_id}/cells/{cell_id}/runs", status_code=201)
async def run_cell(
    notebook_id: NotebookId,
    cell_id: CellId,
    body: RunCreate,
    request: Request,
    user: CurrentUser,
    session: Session,
) -> RunOut:
    """Run a cell's SQL and store the outcome for everyone to see.

    A query that fails because of the query itself (rejected, error, timeout)
    is still a run: it's stored, and the error is shown to everyone. Failures
    of the service (busy, crashed, no engine) are not stored and return 503,
    so the client can retry.

    No database transaction stays open while the query runs (which can take
    many seconds): the existence check ends its transaction first, and the
    run is inserted in a new one afterwards. Otherwise every running query
    would hold a pooled connection, and the run's timestamp would be when the
    request started (Postgres now() is the transaction's start time).
    """
    await _membership(session, notebook_id, user.id, "editor")
    runner: QueryRunner | None = request.app.state.query_runner
    if runner is None:
        raise HTTPException(
            status_code=503,
            detail={"kind": "unavailable", "message": "The query engine is not configured."},
        )
    # End the read transaction and release the connection. (Rollback also
    # expires loaded objects, so nothing below reads `user` or the notebook.)
    await session.rollback()

    result: QueryResult | None = None
    error: dict[str, Any] | None = None
    try:
        result = await runner.run(body.sql)
    except QueryRejectedError as rejected:
        error = {"kind": "rejected", "message": str(rejected)}
    except QueryFailedError as failed:
        if failed.kind in ("busy", "crashed"):
            raise HTTPException(
                status_code=503, detail={"kind": failed.kind, "message": str(failed)}
            ) from None
        error = {"kind": failed.kind, "message": str(failed)}

    run = CellRun(
        notebook_id=notebook_id,
        cell_id=cell_id,
        sql=body.sql,
        status="ok" if error is None else "error",
        result=dict(result) if result is not None else None,
        error=error,
        # clock_timestamp() is the actual time of the insert, i.e. when the
        # query finished, so "newest" means the run that completed last.
        created_at=func.clock_timestamp(),
    )
    session.add(run)
    try:
        await session.flush()
    except IntegrityError as error:
        await session.rollback()
        # Only a foreign-key violation is expected: the notebook was deleted
        # while its query was running. Anything else (a check constraint) is a
        # bug and must surface as one, not as "not found".
        if isinstance(error.orig, ForeignKeyViolation):
            raise _not_found() from None
        raise
    await _prune_runs(session, run)
    await session.commit()
    await session.refresh(run)
    return RunOut.model_validate(run, from_attributes=True)


async def _prune_runs(session: AsyncSession, new_run: CellRun) -> None:
    """Keep `new_run` plus the newest RUNS_KEPT_PER_CELL - 1 other runs of its cell.

    The new run is excluded explicitly, so pruning can never delete the run
    that is being returned. Runs from transactions that haven't committed yet
    are invisible here and are left alone.
    """
    same_cell = (
        CellRun.notebook_id == new_run.notebook_id,
        CellRun.cell_id == new_run.cell_id,
        CellRun.id != new_run.id,
    )
    keep_others = (
        select(CellRun.id)
        .where(*same_cell)
        .order_by(CellRun.created_at.desc(), CellRun.id.desc())
        .limit(RUNS_KEPT_PER_CELL - 1)
    )
    await session.execute(delete(CellRun).where(*same_cell, CellRun.id.not_in(keep_others)))


@router.get("/{notebook_id}/runs/{run_id}")
async def get_run(
    notebook_id: NotebookId, run_id: uuid.UUID, user: CurrentUser, session: Session
) -> RunOut:
    await _membership(session, notebook_id, user.id)
    run = await session.get(CellRun, run_id)
    if run is None or run.notebook_id != notebook_id:
        raise HTTPException(
            status_code=404, detail={"kind": "not_found", "message": "Run not found."}
        )
    return RunOut.model_validate(run, from_attributes=True)
