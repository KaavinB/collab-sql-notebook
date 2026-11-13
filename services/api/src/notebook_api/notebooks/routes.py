"""Notebook routes.

Phase 1 has no auth (D10): every route is open, and the API only listens on
localhost. Phase 2 adds users, sharing and permission checks to each route.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response
from psycopg.errors import ForeignKeyViolation
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from notebook_api.db.models import CellRun, Notebook, NotebookSnapshot
from notebook_api.db.session import get_session
from notebook_api.query.engine import QueryResult
from notebook_api.query.routes import MAX_SQL_CHARS
from notebook_api.query.runner import QueryFailedError, QueryRunner
from notebook_api.query.validate import QueryRejectedError

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
# Pagination arrives with users and sharing in Phase 2.
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


async def _get_notebook(session: AsyncSession, notebook_id: uuid.UUID) -> Notebook:
    notebook = await session.get(Notebook, notebook_id)
    if notebook is None:
        raise _not_found()
    return notebook


def _out(notebook: Notebook) -> NotebookOut:
    return NotebookOut.model_validate(notebook, from_attributes=True)


@router.post("", status_code=201)
async def create_notebook(body: NotebookCreate, session: Session) -> NotebookOut:
    notebook = Notebook(title=body.title)
    session.add(notebook)
    await session.commit()
    await session.refresh(notebook)
    return _out(notebook)


@router.get("")
async def list_notebooks(session: Session) -> list[NotebookOut]:
    rows = await session.scalars(
        select(Notebook).order_by(Notebook.updated_at.desc()).limit(LIST_LIMIT)
    )
    return [_out(n) for n in rows]


@router.get("/{notebook_id}")
async def get_notebook(notebook_id: NotebookId, session: Session) -> NotebookOut:
    return _out(await _get_notebook(session, notebook_id))


@router.patch("/{notebook_id}")
async def update_notebook(
    notebook_id: NotebookId, body: NotebookUpdate, session: Session
) -> NotebookOut:
    notebook = await _get_notebook(session, notebook_id)
    notebook.title = body.title
    await session.commit()
    await session.refresh(notebook)
    return _out(notebook)


@router.delete("/{notebook_id}", status_code=204)
async def delete_notebook(notebook_id: NotebookId, session: Session) -> Response:
    notebook = await _get_notebook(session, notebook_id)
    await session.delete(notebook)  # snapshot and runs go with it (ON DELETE CASCADE)
    await session.commit()
    return Response(status_code=204)


# --- Yjs snapshot (D7) ---------------------------------------------------------

_YJS_MEDIA_TYPE = "application/octet-stream"


@router.get("/{notebook_id}/snapshot")
async def get_snapshot(notebook_id: NotebookId, session: Session) -> Response:
    """The notebook's Yjs state, or 204 if nothing has been saved yet."""
    await _get_notebook(session, notebook_id)
    snapshot = await session.get(NotebookSnapshot, notebook_id)
    if snapshot is None:
        return Response(status_code=204)
    return Response(content=snapshot.state, media_type=_YJS_MEDIA_TYPE)


@router.put("/{notebook_id}/snapshot", status_code=204)
async def put_snapshot(notebook_id: NotebookId, request: Request, session: Session) -> Response:
    """Replace the notebook's Yjs state with the request body.

    The body is `Y.encodeStateAsUpdate(doc)` from the client. The server
    doesn't decode it in Phase 1. Last write wins, which is fine with one
    writer; Phase 2 moves persistence to the sync server.
    """
    max_bytes: int = request.app.state.settings.snapshot_max_bytes
    state = await _read_body_capped(request, max_bytes)
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


async def _read_body_capped(request: Request, max_bytes: int) -> bytes:
    """Read the body, refusing it as soon as it passes `max_bytes`.

    Streaming the check (instead of reading everything first) means an
    oversized upload never sits in memory in full.
    """
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > max_bytes:
        raise _too_large(max_bytes)
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > max_bytes:
            raise _too_large(max_bytes)
        chunks.append(chunk)
    return b"".join(chunks)


def _too_large(max_bytes: int) -> HTTPException:
    return HTTPException(
        status_code=413,
        detail={"kind": "too_large", "message": f"Snapshot is larger than {max_bytes} bytes."},
    )


# --- Shared cell runs (D6) -----------------------------------------------------


@router.post("/{notebook_id}/cells/{cell_id}/runs", status_code=201)
async def run_cell(
    notebook_id: NotebookId, cell_id: CellId, body: RunCreate, request: Request, session: Session
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
    runner: QueryRunner | None = request.app.state.query_runner
    if runner is None:
        raise HTTPException(
            status_code=503,
            detail={"kind": "unavailable", "message": "The query engine is not configured."},
        )
    await _get_notebook(session, notebook_id)
    await session.rollback()  # end the read transaction and release the connection

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
async def get_run(notebook_id: NotebookId, run_id: uuid.UUID, session: Session) -> RunOut:
    run = await session.get(CellRun, run_id)
    if run is None or run.notebook_id != notebook_id:
        raise HTTPException(
            status_code=404, detail={"kind": "not_found", "message": "Run not found."}
        )
    return RunOut.model_validate(run, from_attributes=True)
