"""Refuse state-changing requests that don't come from the web app's own pages.

The session is a cookie, and the browser attaches cookies to requests that
other sites trigger (a form posted from evil.example to this API). That's
cross-site request forgery. SameSite=Lax already keeps the cookie off
cross-site POSTs, but "same-site" includes every subdomain of the site, so
a compromised or user-controlled sibling subdomain would still get through.

Browsers send an `Origin` header on every POST, PUT, PATCH and DELETE, and
pages can't forge it. So any such request whose Origin isn't one of the
allowed web origins is refused before it reaches a route. A request with no
Origin at all (curl, a server) is refused too: there's no browser client of
this API that omits it.
"""

from collections.abc import Iterable

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


class OriginCheckMiddleware:
    def __init__(self, app: ASGIApp, allowed_origins: Iterable[str]) -> None:
        self.app = app
        self.allowed = frozenset(origin.encode("latin-1") for origin in allowed_origins)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] not in _SAFE_METHODS:
            origins = [value for name, value in scope["headers"] if name == b"origin"]
            if len(origins) != 1 or origins[0] not in self.allowed:
                response = JSONResponse(
                    status_code=403,
                    content={
                        "detail": {
                            "kind": "forbidden",
                            "message": "This request must come from the notebook web app.",
                        }
                    },
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)
