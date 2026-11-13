"""POST /query: run one read-only SQL query and return the result table."""

from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from notebook_api.query.engine import QueryResult
from notebook_api.query.runner import QueryFailedError, QueryRunner
from notebook_api.query.validate import QueryRejectedError

router = APIRouter()

# Generous for hand-written or AI-written queries, and keeps parsing cheap:
# sqlglot is pure Python, so parse time grows with the query's length.
MAX_SQL_CHARS = 20_000


class QueryRequest(BaseModel):
    sql: str = Field(min_length=1, max_length=MAX_SQL_CHARS)


ErrorKind = Literal["rejected", "error", "timeout", "busy", "crashed", "unavailable"]

# User-caused failures are 400s; capacity and engine problems are 503s.
_STATUS: dict[ErrorKind, int] = {
    "rejected": 400,
    "error": 400,
    "timeout": 400,
    "busy": 503,
    "crashed": 503,
    "unavailable": 503,
}


def _fail(kind: ErrorKind, message: str) -> HTTPException:
    return HTTPException(status_code=_STATUS[kind], detail={"kind": kind, "message": message})


@router.post("/query", response_model=QueryResult)
async def run_query(body: QueryRequest, request: Request) -> QueryResult:
    runner: QueryRunner | None = request.app.state.query_runner
    if runner is None:
        raise _fail("unavailable", "The query engine is not configured (DUCKDB_PATH).")
    try:
        return await runner.run(body.sql)
    except QueryRejectedError as error:
        raise _fail("rejected", str(error)) from None
    except QueryFailedError as error:
        raise _fail(error.kind, str(error)) from None
