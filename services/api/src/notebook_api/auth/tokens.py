"""Short-lived signed tokens: state the server hands out and later reads back.

Used for the OAuth flow cookie (state + PKCE verifier between the redirect
to the provider and the callback) and for sync-server tickets.

Format: base64url(JSON payload) "." base64url(HMAC-SHA256(key, purpose "." payload)).

- The payload is signed, not encrypted: never put secrets in it that the
  holder must not read. (The PKCE verifier is fine: the holder is the
  browser that started the flow, and the cookie is HttpOnly.)
- `purpose` is part of what's signed, so a token minted for one use (a
  sync ticket) can't be replayed as another (a flow cookie), even though
  both could share a key.
- Every token carries `exp` (Unix seconds); expired tokens are rejected.
"""

import base64
import binascii
import hashlib
import hmac
import json
import time
from collections.abc import Mapping
from typing import Any

# Real tokens are a few hundred bytes. Refuse to parse anything absurd.
MAX_TOKEN_LENGTH = 4096


def _encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _mac(secret: bytes, purpose: str, encoded_payload: str) -> bytes:
    message = f"{purpose}.{encoded_payload}".encode("ascii")
    return hmac.new(secret, message, hashlib.sha256).digest()


def sign(
    payload: Mapping[str, Any],
    *,
    secret: bytes,
    purpose: str,
    ttl_seconds: float,
    now: float | None = None,
) -> str:
    body = {**payload, "exp": int((time.time() if now is None else now) + ttl_seconds)}
    encoded = _encode(json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    return f"{encoded}.{_encode(_mac(secret, purpose, encoded))}"


def verify(
    token: str, *, secret: bytes, purpose: str, now: float | None = None
) -> dict[str, Any] | None:
    """The payload if `token` is genuine, for `purpose`, and unexpired; otherwise None."""
    if len(token) > MAX_TOKEN_LENGTH or not token.isascii():
        return None
    encoded, dot, mac = token.partition(".")
    if not dot:
        return None
    try:
        given = _decode(mac)
    except binascii.Error, ValueError:
        return None
    # Constant-time comparison, so response timing can't reveal the MAC.
    if not hmac.compare_digest(_mac(secret, purpose, encoded), given):
        return None
    try:
        payload = json.loads(_decode(encoded))
    except binascii.Error, ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    expires = payload.get("exp")
    if not isinstance(expires, int) or isinstance(expires, bool):
        return None
    if expires <= (time.time() if now is None else now):
        return None
    return payload


def constant_time_equal(a: str, b: str) -> bool:
    """String equality whose timing doesn't reveal where the strings differ."""
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
