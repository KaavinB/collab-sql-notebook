"""Sign-in, sign-out and "who am I".

GET  /auth/providers               which sign-in methods are configured
GET  /auth/{provider}/login        start OAuth: redirect to GitHub or Google
GET  /auth/{provider}/callback     finish OAuth: create a session, redirect to the web app
POST /auth/dev-login               dev and tests only: sign in by name, no provider
POST /auth/logout                  end this session
GET  /auth/me                      the signed-in user, or 401
"""

import re
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from notebook_api.auth import oauth, tokens
from notebook_api.auth.sessions import (
    CurrentUser,
    clear_session_cookie,
    end_session,
    find_or_create_user,
    session_cookie_name,
    set_session_cookie,
    start_session,
)
from notebook_api.config import Settings
from notebook_api.db.session import get_session

router = APIRouter(prefix="/auth")

Session = Annotated[AsyncSession, Depends(get_session)]

# App-specific: cookies aren't separated by port, so another app on localhost
# could otherwise share the name. (No __Host- prefix: that needs Path=/, and
# this cookie is scoped to /auth.)
_FLOW_COOKIE = "notebook_oauth_flow"
_FLOW_PURPOSE = "oauth-flow"
# Long enough to approve the app at the provider, short enough that a
# leaked flow cookie is soon useless.
_FLOW_TTL_SECONDS = 600
# Where the web app may send someone after sign-in: a path on the web app
# itself. "//evil.example" and "/\\evil.example" are protocol-relative URLs
# that browsers treat as another host, so the second character can't be a
# slash or backslash; control characters are refused too.
_SAFE_NEXT = re.compile(r"^/(?![/\\])[\x21-\x7e]{0,1999}$")
# Sign-in errors the web app knows how to describe; nothing else is passed on.
_DENIED, _EXPIRED, _FAILED = "denied", "expired", "failed"


class UserOut(BaseModel):
    id: uuid.UUID
    name: str


class ProvidersOut(BaseModel):
    providers: list[oauth.ProviderName]
    dev_login: bool


class DevLogin(BaseModel):
    name: str = Field(min_length=1, max_length=60, pattern=r"^[\w .'-]+$")

    @field_validator("name")
    @classmethod
    def _has_a_letter_or_digit(cls, value: str) -> str:
        # The pattern alone accepts "   " or "..", which strip to nothing useful.
        stripped = value.strip()
        if not any(ch.isalnum() for ch in stripped):
            raise ValueError("must contain a letter or digit")
        return stripped


def _settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def _providers(settings: Settings) -> dict[str, oauth.Provider]:
    configured: dict[str, oauth.Provider] = {}
    if settings.github_client_id and settings.github_client_secret:
        configured["github"] = oauth.github(
            settings.github_client_id, settings.github_client_secret.get_secret_value()
        )
    if settings.google_client_id and settings.google_client_secret:
        configured["google"] = oauth.google(
            settings.google_client_id, settings.google_client_secret.get_secret_value()
        )
    return configured


def _flow_secret(settings: Settings) -> bytes:
    if settings.auth_secret is None:
        raise HTTPException(
            status_code=503,
            detail={"kind": "unavailable", "message": "Sign-in is not configured."},
        )
    return settings.auth_secret.get_secret_value().encode("utf-8")


def _provider(settings: Settings, name: str) -> oauth.Provider:
    provider = _providers(settings).get(name)
    if provider is None:
        raise HTTPException(
            status_code=404,
            detail={"kind": "not_found", "message": "That sign-in method isn't available."},
        )
    return provider


def _callback_url(settings: Settings, provider: str) -> str:
    return f"{settings.api_public_url}/auth/{provider}/callback"


def _web_redirect(settings: Settings, path: str) -> RedirectResponse:
    # 303: the browser follows with a GET, whatever the original method.
    return RedirectResponse(f"{settings.web_url}{path}", status_code=303)


def _signin_failed(settings: Settings, reason: str) -> RedirectResponse:
    response = _web_redirect(settings, f"/?signin_error={reason}")
    response.delete_cookie(_FLOW_COOKIE, path="/auth")
    return response


@router.get("/providers")
async def providers(request: Request) -> ProvidersOut:
    settings = _settings(request)
    ready = settings.auth_secret is not None
    return ProvidersOut(
        providers=sorted(_providers(settings)) if ready else [],
        dev_login=settings.auth_dev_login and ready,
    )


@router.get("/{provider}/login")
async def login(
    provider: oauth.ProviderName,
    request: Request,
    next_path: Annotated[str, Query(alias="next")] = "/",
) -> RedirectResponse:
    settings = _settings(request)
    selected = _provider(settings, provider)
    secret = _flow_secret(settings)
    state, verifier = oauth.new_state(), oauth.new_verifier()
    flow = tokens.sign(
        {
            "provider": provider,
            "state": state,
            "verifier": verifier,
            "next": next_path if _SAFE_NEXT.fullmatch(next_path) else "/",
        },
        secret=secret,
        purpose=_FLOW_PURPOSE,
        ttl_seconds=_FLOW_TTL_SECONDS,
    )
    response = RedirectResponse(
        selected.authorize_redirect(
            redirect_uri=_callback_url(settings, provider), state=state, verifier=verifier
        ),
        status_code=303,
    )
    response.set_cookie(
        _FLOW_COOKIE,
        flow,
        max_age=_FLOW_TTL_SECONDS,
        path="/auth",  # only the callback needs it
        httponly=True,
        secure=settings.auth_cookie_secure,
        # Lax, not Strict: the callback is a top-level navigation coming from
        # the provider's site, and Strict cookies aren't sent on those.
        samesite="lax",
    )
    return response


@router.get("/{provider}/callback")
async def callback(
    provider: oauth.ProviderName,
    request: Request,
    session: Session,
    code: str | None = Query(default=None, max_length=2000),
    state: str | None = Query(default=None, max_length=200),
    error: str | None = Query(default=None, max_length=200),
) -> RedirectResponse:
    settings = _settings(request)
    selected = _provider(settings, provider)
    if error is not None:  # the user clicked "cancel" at the provider
        return _signin_failed(settings, _DENIED)
    flow: dict[str, Any] | None = None
    cookie = request.cookies.get(_FLOW_COOKIE)
    if cookie:
        flow = tokens.verify(cookie, secret=_flow_secret(settings), purpose=_FLOW_PURPOSE)
    if flow is None:
        # No cookie, a forged one, or one older than the flow's lifetime.
        return _signin_failed(settings, _EXPIRED)
    # The state must be the one this browser was given. Otherwise another site
    # could make the browser finish a sign-in it started, logging the victim
    # into the attacker's account (login CSRF).
    if (
        code is None
        or state is None
        or flow.get("provider") != provider
        or not isinstance(flow.get("state"), str)
        or not tokens.constant_time_equal(flow["state"], state)
    ):
        return _signin_failed(settings, _FAILED)
    try:
        profile = await oauth.fetch_profile(
            selected,
            code=code,
            verifier=str(flow["verifier"]),
            redirect_uri=_callback_url(settings, provider),
            transport=request.app.state.oauth_transport,
        )
    except oauth.OAuthError:
        return _signin_failed(settings, _FAILED)

    user = await find_or_create_user(session, profile.provider, profile.subject, profile.name)
    token = await start_session(session, user.id, settings.session_days)
    await session.commit()
    next_path = flow.get("next")
    response = _web_redirect(
        settings,
        next_path if isinstance(next_path, str) and _SAFE_NEXT.fullmatch(next_path) else "/",
    )
    response.delete_cookie(_FLOW_COOKIE, path="/auth")
    set_session_cookie(response, token, settings)
    return response


@router.post("/dev-login")
async def dev_login(
    body: DevLogin, request: Request, response: Response, session: Session
) -> UserOut:
    """Sign in as a named test user, with no provider. Off unless AUTH_DEV_LOGIN=true.

    Settings refuse AUTH_DEV_LOGIN unless the API only listens on localhost,
    so it can't be switched on in a deployment by mistake.
    """
    settings = _settings(request)
    if not settings.auth_dev_login:
        raise HTTPException(
            status_code=404,
            detail={"kind": "not_found", "message": "That sign-in method isn't available."},
        )
    _flow_secret(settings)  # same "configured" rule as the real providers
    name = body.name  # stripped by the model
    user = await find_or_create_user(session, "dev", name.lower(), name)
    token = await start_session(session, user.id, settings.session_days)
    await session.commit()
    set_session_cookie(response, token, settings)  # FastAPI copies it onto the reply
    return UserOut(id=user.id, name=user.name)


@router.post("/logout", status_code=204)
async def logout(request: Request, session: Session) -> Response:
    token = request.cookies.get(session_cookie_name(_settings(request)))
    if token and len(token) <= 200:
        await end_session(session, token)
        await session.commit()
    response = Response(status_code=204)
    clear_session_cookie(response, _settings(request))
    return response


@router.get("/me")
async def me(user: CurrentUser) -> UserOut:
    return UserOut(id=user.id, name=user.name)
