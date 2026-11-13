"""AI assistant routes: ask about a cell, and accept or reject a suggestion.

Both need an editor (or owner): asking writes shared state (everyone sees
the assistant working on the cell and its suggestion), and so does a
decision. A suggestion is never applied here: the person who accepts it
applies the SQL to the cell as their own edit, then records the decision.
"""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Body, HTTPException, Request
from pydantic import BaseModel, Field

from notebook_api.ai.service import (
    AiService,
    AiTask,
    Busy,
    Done,
    Failed,
    Gone,
    Overloaded,
    UserBusy,
    decide,
)
from notebook_api.auth.sessions import CurrentUser
from notebook_api.db.models import AiSuggestion
from notebook_api.notebooks.access import NotebookId, Session, membership, not_found
from notebook_api.notebooks.routes import CellId
from notebook_api.query.validate import MAX_SQL_CHARS

router = APIRouter(prefix="/notebooks")

PROMPT_MAX_CHARS = 2000
ERROR_MAX_CHARS = 4000


class GenerateRequest(BaseModel):
    kind: Literal["generate"]
    prompt: str = Field(min_length=1, max_length=PROMPT_MAX_CHARS)


class FixRequest(BaseModel):
    kind: Literal["fix"]
    sql: str = Field(min_length=1, max_length=MAX_SQL_CHARS)
    error: str = Field(min_length=1, max_length=ERROR_MAX_CHARS)


class ExplainRequest(BaseModel):
    kind: Literal["explain"]
    sql: str = Field(min_length=1, max_length=MAX_SQL_CHARS)


AiRequestBody = Annotated[GenerateRequest | FixRequest | ExplainRequest, Body(discriminator="kind")]


class DecisionRequest(BaseModel):
    decision: Literal["accepted", "rejected"]


class SuggestionOut(BaseModel):
    id: uuid.UUID
    cell_id: str
    kind: Literal["generate", "fix", "explain"]
    status: Literal["pending", "accepted", "rejected"]
    sql: str | None
    explanation: str
    base_sql: str | None  # the cell SQL the request was about (fix, explain)
    valid: bool
    created_at: datetime


def _out(suggestion: AiSuggestion) -> SuggestionOut:
    return SuggestionOut.model_validate(suggestion, from_attributes=True)


def _task(body: GenerateRequest | FixRequest | ExplainRequest) -> AiTask:
    if isinstance(body, GenerateRequest):
        return AiTask(kind="generate", prompt=body.prompt)
    if isinstance(body, FixRequest):
        return AiTask(kind="fix", sql=body.sql, error=body.error)
    return AiTask(kind="explain", sql=body.sql)


@router.post(
    "/{notebook_id}/cells/{cell_id}/ai",
    responses={
        409: {"description": "This cell already has an AI request in flight"},
        429: {"description": "Too many AI requests from this user (recently, or at once)"},
        502: {"description": "The assistant couldn't produce a suggestion (message says why)"},
        503: {"description": "The AI assistant is not configured, or is busy (kind 'busy')"},
    },
)
async def ask_ai(
    notebook_id: NotebookId,
    cell_id: CellId,
    body: AiRequestBody,
    request: Request,
    user: CurrentUser,
    session: Session,
) -> SuggestionOut:
    """Generate, fix or explain a cell's SQL. Answers once the suggestion is ready.

    Everyone in the notebook sees the assistant working, and then its
    suggestion or failure, through the document (NOTIFY -> sync server).
    No database transaction stays open while the model works.
    """
    await membership(session, notebook_id, user.id, "editor")
    ai: AiService | None = request.app.state.ai
    if ai is None:
        raise HTTPException(
            status_code=503,
            detail={"kind": "unavailable", "message": "The AI assistant is not configured."},
        )
    user_id, user_name = user.id, user.name
    # End the read transaction and release the connection before the slow
    # part. (Rollback also expires loaded objects; nothing below reads them.)
    await session.rollback()

    if not ai.rate_limiter.try_acquire(user_id):
        raise HTTPException(
            status_code=429,
            detail={
                "kind": "rate_limited",
                "message": "You've asked the AI assistant a lot in the last few minutes. "
                "Try again shortly.",
            },
        )
    outcome = await ai.request(notebook_id, cell_id, user_id, user_name, _task(body))
    if isinstance(outcome, (Busy, UserBusy, Overloaded)):
        # Nothing ran, so it doesn't count against the rate limit.
        ai.rate_limiter.refund(user_id)
    if isinstance(outcome, Busy):
        raise HTTPException(status_code=409, detail={"kind": "busy", "message": outcome.message})
    if isinstance(outcome, UserBusy):
        raise HTTPException(
            status_code=429,
            detail={
                "kind": "rate_limited",
                "message": "The AI assistant is already answering two of your requests. "
                "Wait for one to finish.",
            },
        )
    if isinstance(outcome, Overloaded):
        raise HTTPException(
            status_code=503,
            detail={
                "kind": "busy",
                "message": "The AI assistant is busy with other requests. Try again in a moment.",
            },
        )
    if isinstance(outcome, Gone):
        raise not_found()
    if isinstance(outcome, Failed):
        raise HTTPException(
            status_code=502, detail={"kind": "ai_failed", "message": outcome.message}
        )
    assert isinstance(outcome, Done)  # noqa: S101 (narrowing; the union is exhausted)
    return _out(outcome.suggestion)


@router.post("/{notebook_id}/ai/suggestions/{suggestion_id}/decision")
async def decide_suggestion(
    notebook_id: NotebookId,
    suggestion_id: uuid.UUID,
    body: DecisionRequest,
    user: CurrentUser,
    session: Session,
) -> SuggestionOut:
    """Record that a pending suggestion was accepted or rejected (once)."""
    await membership(session, notebook_id, user.id, "editor")
    result = await decide(session, notebook_id, suggestion_id, user.id, body.decision)
    if result == "not_found":
        raise HTTPException(
            status_code=404, detail={"kind": "not_found", "message": "Suggestion not found."}
        )
    if result == "decided":
        raise HTTPException(
            status_code=409,
            detail={"kind": "decided", "message": "This suggestion was already decided."},
        )
    return _out(result)
