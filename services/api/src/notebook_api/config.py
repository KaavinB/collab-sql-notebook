"""Runtime configuration, read from environment variables only.

In dev, `pnpm dev:api` loads the repo-root .env through `uv run --env-file`.
In production the platform sets real environment variables. The app never
looks for a .env file itself, so it behaves the same however it's installed.
"""

import ipaddress
from pathlib import Path
from typing import Annotated, Literal, Self
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

AiModel = Literal["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]
AiEffort = Literal["low", "medium", "high"]


class Settings(BaseSettings):
    # The shared .env also holds web and Postgres variables; ignore unknown ones.
    model_config = SettingsConfigDict(extra="ignore")

    # Localhost by default, so a dev machine never exposes the API to its
    # network. A deployment sets API_HOST explicitly.
    api_host: str = "127.0.0.1"
    api_port: int = 8010
    # Auto-reload on file changes. Dev only; off unless API_RELOAD=true.
    api_reload: bool = False
    # Bounds JSON parsing, including unknown fields, before validation runs.
    # 256 KiB fits 20,000 SQL characters even with JSON's surrogate escaping.
    api_max_body_bytes: int = Field(default=262_144, ge=1_000)

    # --- Database (PostgreSQL) ---
    # SQLAlchemy URL using the psycopg 3 driver. Unset means notebook routes
    # answer 503. Schema changes go through Alembic (`pnpm db:migrate`).
    database_url: str | None = None

    # --- Query engine (read-only worker processes) ---
    # The DuckDB file built by `pnpm ingest`. Unset means running a cell answers 503.
    # A relative path resolves against the API's working directory
    # (services/api when started with `pnpm dev:api`).
    duckdb_path: Path | None = None
    # Where workers spill big sorts and joins. Defaults to <duckdb dir>/spill.
    # Only `worker-*` subdirectories in it are ever created or deleted.
    query_spill_dir: Path | None = None
    # The limits below are starting values, not tuned yet. Phase 4's load test
    # measures them; until then they're deliberately conservative.
    query_workers: int = Field(default=2, ge=1, le=32)
    query_threads_per_worker: int = Field(default=2, ge=1, le=16)
    # DuckDB's own memory_limit, per worker. It governs DuckDB's buffer
    # manager, not every allocation, so it is not the worker's total.
    query_memory_limit_mb: int = Field(default=512, ge=64)
    # Hard cap on each worker's writable memory (RLIMIT_DATA). Enforced on
    # Linux only (production); macOS ignores it. Must leave room above the
    # DuckDB limit for the interpreter, libraries and result conversion.
    query_process_memory_cap_mb: int = Field(default=1536, ge=256)
    query_max_spill_size_mb: int = Field(default=2048, ge=0)  # per worker
    query_timeout_seconds: float = Field(default=10.0, gt=0, le=300)
    # A result table people read in a browser; charts aggregate in SQL first.
    query_row_limit: int = Field(default=5000, ge=1, le=100_000)
    # Serialized result size cap, so one wide result can't bloat a response.
    query_max_result_bytes: int = Field(default=5_000_000, ge=1_000)
    # How long a request waits for a free worker before it's refused as busy.
    query_queue_timeout_seconds: float = Field(default=5.0, gt=0, le=60)

    # Browser origins allowed to call the API. Set as a comma-separated string.
    api_cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:3000"]

    # Host header values the API answers to. Blocks DNS rebinding, where a
    # malicious page points its own domain at 127.0.0.1 to reach this API.
    api_allowed_hosts: Annotated[list[str], NoDecode] = ["127.0.0.1", "localhost"]

    # --- Auth ---
    # The web app's origin. Users land here after signing in; it must be one
    # of API_CORS_ORIGINS.
    web_url: str = "http://localhost:3000"
    # This API's URL as browsers reach it. OAuth callback URLs are built from
    # it, and must match what's registered with GitHub and Google.
    api_public_url: str = "http://localhost:8010"
    # Signs the short-lived OAuth flow cookie. At least 32 characters; unset
    # means sign-in answers 503. Generate one with `openssl rand -hex 32`.
    auth_secret: SecretStr | None = None
    # Mark the session cookie Secure (HTTPS only). Only a plain-HTTP dev setup
    # turns this off.
    auth_cookie_secure: bool = True
    session_days: int = Field(default=30, ge=1, le=365)
    # OAuth apps. A provider is offered only when both of its values are set.
    github_client_id: str | None = None
    github_client_secret: SecretStr | None = None
    google_client_id: str | None = None
    google_client_secret: SecretStr | None = None
    # Sign in by typing a name, with no provider: for e2e tests and local
    # development only. Refused unless the API listens on loopback only.
    auth_dev_login: bool = False

    # --- Live collaboration (the sync server) ---
    # Signs the short-lived tickets the browser shows the sync server when it
    # connects. The sync server is configured with the same value. At least
    # 32 characters and different from AUTH_SECRET, so a leak of one doesn't
    # expose the other. Unset means the sync-ticket route answers 503.
    sync_ticket_secret: SecretStr | None = None
    # The sync server's WebSocket URL as browsers reach it (ws:// or wss://).
    # Handed to the browser together with each ticket.
    sync_public_url: str = "ws://localhost:8020"

    # --- AI assistant ---
    # The Anthropic API key. Unset means the AI routes answer 503. It's only
    # ever sent to the Anthropic API: never logged, never passed to query
    # workers (they start with an allowlisted environment).
    anthropic_api_key: SecretStr | None = None
    # Which Claude model answers. A short allowlist: these are the models the
    # client's request shape (effort, adaptive thinking, refusal fallbacks)
    # has been written for.
    ai_model: AiModel = "claude-haiku-5-5"
    # How much the model thinks before answering. Sent on every request,
    # because the models' own defaults differ (Haiku 5.5 and Opus 5.5 default
    # to medium, Sonnet 5.5 to high) and comparisons need the same level.
    ai_effort: AiEffort = "medium"
    # When the model declines a request, let the API retry it on the fallback
    # model Anthropic recommends for that kind of refusal. Only Sonnet 5.5 and
    # Opus 5.5 have a server-side fallback; ignored for Haiku 5.5.
    ai_refusal_fallbacks: bool = True
    # AI requests this API process runs at once; past it, new ones are
    # refused as busy (503) rather than queued. Each request makes its model
    # calls and EXPLAINs one at a time, so this bounds both the calls in
    # flight against the Anthropic rate limit and how many EXPLAINs can
    # compete with people's queries for the query workers (QUERY_WORKERS,
    # default 2). 4 lets a few people use the assistant at once. A starting
    # value, not tuned; per process, so several API processes multiply it.
    ai_max_concurrent: int = Field(default=4, ge=1, le=64)
    # Answer with canned, deterministic replies instead of calling Claude, so
    # end-to-end tests run without a key. Same loopback-only rule as
    # AUTH_DEV_LOGIN: refused anywhere a real user could reach it.
    ai_fake_model: bool = False

    @field_validator(
        "auth_secret",
        "github_client_id",
        "github_client_secret",
        "google_client_id",
        "google_client_secret",
        "sync_ticket_secret",
        "anthropic_api_key",
        mode="before",
    )
    @classmethod
    def _blank_means_unset(cls, value: object) -> object:
        # .env.example lists these with empty values; an empty line means
        # "not configured", not "configured with an empty secret".
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("web_url", "api_public_url")
    @classmethod
    def _bare_origin_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            raise ValueError("must be an http(s) URL")
        if parts.query or parts.fragment or parts.username or parts.password:
            raise ValueError("must not contain credentials, a query or a fragment")
        return value.rstrip("/")

    @field_validator("auth_secret")
    @classmethod
    def _long_secret(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and len(value.get_secret_value()) < 32:
            raise ValueError("AUTH_SECRET must be at least 32 characters")
        return value

    @field_validator("sync_public_url")
    @classmethod
    def _websocket_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme not in ("ws", "wss") or not parts.hostname:
            raise ValueError("SYNC_PUBLIC_URL must be a ws:// or wss:// URL")
        if parts.query or parts.fragment or parts.username or parts.password:
            raise ValueError("SYNC_PUBLIC_URL must not contain credentials, a query or a fragment")
        return value.rstrip("/")

    @field_validator("sync_ticket_secret")
    @classmethod
    def _long_sync_secret(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and len(value.get_secret_value()) < 32:
            raise ValueError("SYNC_TICKET_SECRET must be at least 32 characters")
        return value

    @model_validator(mode="after")
    def _sync_secret_is_its_own(self) -> Self:
        if (
            self.sync_ticket_secret is not None
            and self.auth_secret is not None
            and self.sync_ticket_secret.get_secret_value() == self.auth_secret.get_secret_value()
        ):
            raise ValueError("SYNC_TICKET_SECRET must differ from AUTH_SECRET")
        return self

    @model_validator(mode="after")
    def _web_url_is_an_allowed_origin(self) -> Self:
        if self.web_url not in self.api_cors_origins:
            raise ValueError("WEB_URL must be one of API_CORS_ORIGINS")
        return self

    @model_validator(mode="after")
    def _dev_login_only_on_loopback(self) -> Self:
        """Dev sign-in only for a server nobody else can reach.

        API_HOST alone isn't proof: `uvicorn --host 0.0.0.0` or a reverse
        proxy bypasses it. So every name the server answers to (the Host
        allowlist), the web app's URL and the API's public URL must all be
        loopback too (a deployment can't work without its public host in
        those), and cookies must be the plain-HTTP dev kind.
        """
        if self.auth_dev_login and not self._local_only():
            raise ValueError(
                "AUTH_DEV_LOGIN lets anyone create and use test accounts without a "
                "provider; it requires API_HOST, API_ALLOWED_HOSTS, WEB_URL and "
                "API_PUBLIC_URL to be loopback-only and AUTH_COOKIE_SECURE=false"
            )
        return self

    @model_validator(mode="after")
    def _fake_model_only_on_loopback(self) -> Self:
        """The fake model only for a server nobody else can reach (as dev sign-in).

        Its canned answers would otherwise reach real users as if they came
        from the assistant.
        """
        if self.ai_fake_model and not self._local_only():
            raise ValueError(
                "AI_FAKE_MODEL answers with canned test replies; it requires API_HOST, "
                "API_ALLOWED_HOSTS, WEB_URL and API_PUBLIC_URL to be loopback-only and "
                "AUTH_COOKIE_SECURE=false"
            )
        return self

    def _local_only(self) -> bool:
        """Whether every name this server answers to is loopback, with dev (non-Secure) cookies."""
        hosts = [
            self.api_host,
            *self.api_allowed_hosts,
            urlsplit(self.web_url).hostname or "",
            urlsplit(self.api_public_url).hostname or "",
        ]
        return all(_is_loopback(host) for host in hosts) and not self.auth_cookie_secure

    @model_validator(mode="after")
    def _memory_cap_above_duckdb_limit(self) -> Self:
        if self.query_process_memory_cap_mb <= self.query_memory_limit_mb:
            raise ValueError(
                "QUERY_PROCESS_MEMORY_CAP_MB must be larger than QUERY_MEMORY_LIMIT_MB"
            )
        return self

    @field_validator("api_allowed_hosts", mode="before")
    @classmethod
    def _split_hosts(cls, value: object) -> object:
        if isinstance(value, str):
            return [host.strip() for host in value.split(",") if host.strip()]
        return value

    @field_validator("api_cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @field_validator("api_cors_origins")
    @classmethod
    def _reject_wildcard(cls, origins: list[str]) -> list[str]:
        # A wildcard plus credentialed requests (auth cookies, Phase 2) would let
        # any site act as the signed-in user. Origins must be listed explicitly.
        if "*" in origins:
            raise ValueError("API_CORS_ORIGINS must list explicit origins, not '*'")
        return origins


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False
