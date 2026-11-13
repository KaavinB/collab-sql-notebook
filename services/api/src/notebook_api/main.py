"""FastAPI application factory and dev entry point."""

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from notebook_api.config import Settings


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="Collab SQL Notebook API")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.api_cors_origins,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type"],
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


def run() -> None:
    """Entry point for `pnpm dev:api` (or `uv run notebook-api`)."""
    settings = Settings()
    uvicorn.run(
        "notebook_api.main:create_app",
        factory=True,
        host=settings.api_host,
        port=settings.api_port,
        reload=settings.api_reload,
    )
