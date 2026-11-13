"""Runtime configuration, read from environment variables only.

In dev, `pnpm dev:api` loads the repo-root .env through `uv run --env-file`.
In production the platform sets real environment variables. The app never
looks for a .env file itself, so it behaves the same however it's installed.
"""

from typing import Annotated

from pydantic import field_validator
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

    # Browser origins allowed to call the API. Set as a comma-separated string.
    api_cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:3000"]

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
