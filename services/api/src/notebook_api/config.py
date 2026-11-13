"""Runtime configuration, read from environment variables only.

In dev, `pnpm dev:api` loads the repo-root .env through `uv run --env-file`.
In production the platform sets real environment variables. The app never
looks for a .env file itself, so it behaves the same however it's installed.
"""

from pathlib import Path
from typing import Annotated, Self

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    # The shared .env also holds web and Postgres variables; ignore unknown ones.
    model_config = SettingsConfigDict(extra="ignore")

    # Localhost by default: Phase 1 has no auth, so the API must not be reachable
    # from the network unless a deployment explicitly sets API_HOST.
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    # Auto-reload on file changes. Dev only; off unless API_RELOAD=true.
    api_reload: bool = False

    # --- Query engine (D3, D4, D5) ---
    # The DuckDB file built by `pnpm ingest`. Unset means /query answers 503.
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
    # manager, not every allocation (D4), so it is not the worker's total.
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
