"""Bound request bodies before JSON decoding or dependency execution."""

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = self.max_bytes
        response = JSONResponse(
            status_code=413,
            content={
                "detail": {
                    "kind": "too_large",
                    "message": f"Request body is larger than {limit} bytes.",
                }
            },
        )
        for name, value in scope["headers"]:
            if name.lower() == b"content-length" and value.isdigit():
                # Compare decimal strings: int() can itself fail on a header
                # containing thousands of digits. Leading zeroes are harmless.
                declared = value.lstrip(b"0") or b"0"
                maximum = str(limit).encode("ascii")
                if len(declared) > len(maximum) or (
                    len(declared) == len(maximum) and declared > maximum
                ):
                    await response(scope, receive, send)
                    return

        # Buffer at most the limit, counting actual bytes even if the length
        # header is missing or false. Do this before calling FastAPI: checking
        # after Request.body()/JSON decoding would already allocate the upload.
        buffered = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(buffered) + len(chunk) > limit:
                await response(scope, receive, send)
                return
            buffered.extend(chunk)
            if not message.get("more_body", False):
                break
        body = bytes(buffered)
        buffered.clear()
        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)
