"""OAuth 2.0 authorization-code sign-in with GitHub and Google.

The flow, for one sign-in:

1. /auth/{provider}/login makes a random `state` and a PKCE `verifier`,
   keeps both in a short-lived signed cookie, and redirects the browser to
   the provider with `state` and `challenge = SHA-256(verifier)`.
2. The user approves; the provider redirects back to
   /auth/{provider}/callback with `code` and the same `state`.
3. The callback checks `state` against the cookie (so a login can't be
   started by another site: CSRF on the callback), then exchanges `code`
   plus `verifier` for an access token. PKCE means an intercepted `code` is
   useless without the verifier, which never left this server and the
   user's browser cookie.
4. The access token is used once, to read the user's profile, and is then
   dropped: we only need to know who the user is, not to act for them.

Users are matched by (provider, provider's user ID), never by email: an
email address on an OAuth profile isn't proof of owning it at every
provider, so matching by email would let one account take over another.
"""

import base64
import hashlib
import secrets
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlencode

import httpx2

ProviderName = Literal["github", "google"]

# Sent with every request to the providers. GitHub rejects requests without
# a User-Agent; a generic name identifies the app without identifying anyone.
_USER_AGENT = "collab-sql-notebook"
_TIMEOUT_SECONDS = 10.0


class OAuthError(Exception):
    """Sign-in with the provider failed. The message is safe to show users."""


@dataclass(frozen=True)
class Profile:
    provider: str
    subject: str  # the provider's stable user ID
    name: str


@dataclass(frozen=True)
class Provider:
    name: ProviderName
    client_id: str
    client_secret: str
    authorize_url: str
    token_url: str
    profile_url: str
    scope: str

    def authorize_redirect(self, *, redirect_uri: str, state: str, verifier: str) -> str:
        query = {
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": self.scope,
            "state": state,
            "code_challenge": pkce_challenge(verifier),
            "code_challenge_method": "S256",
        }
        return f"{self.authorize_url}?{urlencode(query)}"


def github(client_id: str, client_secret: str) -> Provider:
    return Provider(
        name="github",
        client_id=client_id,
        client_secret=client_secret,
        authorize_url="https://github.com/login/oauth/authorize",
        token_url="https://github.com/login/oauth/access_token",  # noqa: S106 (a URL, not a secret)
        profile_url="https://api.github.com/user",
        scope="read:user",  # public profile only; no repository or email access
    )


def google(client_id: str, client_secret: str) -> Provider:
    return Provider(
        name="google",
        client_id=client_id,
        client_secret=client_secret,
        authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",  # noqa: S106 (a URL, not a secret)
        profile_url="https://openidconnect.googleapis.com/v1/userinfo",
        scope="openid profile",  # name and picture; no email
    )


def new_state() -> str:
    return secrets.token_urlsafe(32)


def new_verifier() -> str:
    # RFC 7636: 43-128 characters from the unreserved set; 32 random bytes
    # in base64url are 43 characters.
    return secrets.token_urlsafe(32)


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


async def fetch_profile(
    provider: Provider,
    *,
    code: str,
    verifier: str,
    redirect_uri: str,
    transport: httpx2.AsyncBaseTransport | None = None,
) -> Profile:
    """Exchange the authorization code for a token, then read the profile."""
    async with httpx2.AsyncClient(
        transport=transport,
        timeout=_TIMEOUT_SECONDS,
        headers={"User-Agent": _USER_AGENT, "Accept": "application/json"},
    ) as client:
        try:
            token_response = await client.post(
                provider.token_url,
                data={
                    "client_id": provider.client_id,
                    "client_secret": provider.client_secret,
                    "code": code,
                    "code_verifier": verifier,
                    "grant_type": "authorization_code",
                    "redirect_uri": redirect_uri,
                },
            )
            token = _json_object(token_response)
            access_token = token.get("access_token")
            # GitHub answers 200 with {"error": ...} for a bad code.
            if token_response.status_code != 200 or not isinstance(access_token, str):
                raise OAuthError("The sign-in provider rejected the sign-in. Please try again.")
            profile_response = await client.get(
                provider.profile_url, headers={"Authorization": f"Bearer {access_token}"}
            )
        except httpx2.HTTPError:
            raise OAuthError("Could not reach the sign-in provider. Please try again.") from None
    if profile_response.status_code != 200:
        raise OAuthError("Could not read your profile from the sign-in provider.")
    return _profile(provider.name, _json_object(profile_response))


def _json_object(response: httpx2.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _text(value: object, limit: int) -> str | None:
    return value[:limit] if isinstance(value, str) and value.strip() else None


def _profile(provider: ProviderName, body: dict[str, Any]) -> Profile:
    if provider == "github":
        user_id = body.get("id")
        if not isinstance(user_id, int) or isinstance(user_id, bool):
            raise OAuthError("The sign-in provider returned an unexpected profile.")
        subject = str(user_id)
        name = _text(body.get("name"), 200) or _text(body.get("login"), 200)
    else:
        sub = body.get("sub")
        if not isinstance(sub, str) or not sub:
            raise OAuthError("The sign-in provider returned an unexpected profile.")
        subject = sub[:255]
        name = _text(body.get("name"), 200)
    return Profile(provider=provider, subject=subject, name=name or "Anonymous")
