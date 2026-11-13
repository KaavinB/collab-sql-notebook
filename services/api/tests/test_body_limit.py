"""Exercise ASGI chunks directly: TestClient may combine streamed uploads."""

import json

import pytest
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import Message, Receive, Scope, Send

from notebook_api.body_limit import BodyLimitMiddleware

pytestmark = pytest.mark.anyio


async def _upload(
    chunks: list[bytes],
    headers: list[tuple[bytes, bytes]] | None = None,
    path: str = "/notebooks",
    method: str = "POST",
    disconnect: bool = False,
) -> tuple[list[Message], list[bytes], int]:
    responses: list[Message] = []
    delivered: list[bytes] = []
    reads = 0

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        delivered.append(await Request(scope, receive).body())
        await Response(status_code=204)(scope, receive, send)

    async def receive() -> Message:
        nonlocal reads
        index = reads
        reads += 1
        if disconnect:
            return {"type": "http.disconnect"}
        if index >= len(chunks):
            raise AssertionError("read past the supplied chunks")
        return {
            "type": "http.request",
            "body": chunks[index],
            "more_body": index + 1 < len(chunks),
        }

    async def send(message: Message) -> None:
        responses.append(message)

    middleware = BodyLimitMiddleware(app, max_bytes=10)
    await middleware(
        {"type": "http", "method": method, "path": path, "headers": headers or []}, receive, send
    )
    return responses, delivered, reads


@pytest.mark.parametrize("length", [None, b"1", b"invalid"])
async def test_counts_streamed_bytes_and_stops_without_running_the_app(
    length: bytes | None,
) -> None:
    headers = [(b"content-length", length)] if length is not None else []
    responses, delivered, reads = await _upload([b"123456", b"78901", b"not-read"], headers)
    assert responses[0]["status"] == 413
    assert json.loads(responses[1]["body"])["detail"]["kind"] == "too_large"
    assert delivered == []
    assert reads == 2


@pytest.mark.parametrize("length", [b"11", b"9" * 5_000])
async def test_rejects_an_oversized_declared_body_without_reading_it(length: bytes) -> None:
    responses, delivered, reads = await _upload([], [(b"content-length", length)])
    assert responses[0]["status"] == 413
    assert delivered == []
    assert reads == 0


async def test_replays_an_exact_limit_body_once() -> None:
    responses, delivered, reads = await _upload(
        [b"1234", b"567890"], [(b"content-length", b"0000000010")]
    )
    assert responses[0]["status"] == 204
    assert delivered == [b"1234567890"]
    assert reads == 2


async def test_a_disconnected_upload_does_not_run_the_app() -> None:
    responses, delivered, reads = await _upload([], disconnect=True)
    assert responses == []
    assert delivered == []
    assert reads == 1
