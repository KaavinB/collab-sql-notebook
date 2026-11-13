"""FastAPI application factory and dev entry point."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse

from notebook_api.body_limit import BodyLimitMiddleware
from notebook_api.config import Settings
from notebook_api.db.session import create_engine, make_sessionmaker
from notebook_api.notebooks.routes import router as notebooks_router
from notebook_api.query.engine import EngineLimits
from notebook_api.query.runner import QueryRunner


def build_query_runner(settings: Settings) -> QueryRunner | None:
    if settings.duckdb_path is None:
        return None
    db_path = settings.duckdb_path.resolve()
    spill_root = (settings.query_spill_dir or db_path.parent / "spill").resolve()
    limits = EngineLimits(
        memory_limit_mb=settings.query_memory_limit_mb,
        process_memory_cap_mb=settings.query_process_memory_cap_mb,
        threads=settings.query_threads_per_worker,
        max_spill_size_mb=settings.query_max_spill_size_mb,
        timeout_seconds=settings.query_timeout_seconds,
        row_limit=settings.query_row_limit,
        max_result_bytes=settings.query_max_result_bytes,
    )
    return QueryRunner(
        db_path=db_path,
        spill_root=spill_root,
        limits=limits,
        workers=settings.query_workers,
        queue_timeout_seconds=settings.query_queue_timeout_seconds,
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.settings = settings
        engine = create_engine(settings.database_url) if settings.database_url else None
        app.state.sessions = make_sessionmaker(engine) if engine else None
        runner = build_query_runner(settings)
        try:
            if runner is not None:
                # Fails startup loudly if the database is missing or a worker
                # can't open it, rather than failing on the first query.
                await runner.start()
            app.state.query_runner = runner
            yield
        finally:
            if runner is not None:
                await runner.close()
            if engine is not None:
                await engine.dispose()

    app = FastAPI(title="Collab SQL Notebook API", lifespan=lifespan)
    app.add_middleware(
        BodyLimitMiddleware,
        max_bytes=settings.api_max_body_bytes,
        snapshot_max_bytes=settings.snapshot_max_bytes,
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.api_allowed_hosts)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.api_cors_origins,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type"],
    )

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError) -> JSONResponse:
        # FastAPI's default 422 includes the rejected input (including SQL or
        # document contents). Keep errors small and never echo submitted data.
        # Each error's location and message describe the rule, not the value
        # (e.g. "body.sql: String should have at most 20000 characters").
        problems = [
            f"{'.'.join(str(part) for part in e.get('loc', ()))}: {e.get('msg', 'invalid')}"
            for e in error.errors()[:3]
        ]
        return JSONResponse(
            status_code=422,
            content={
                "detail": {
                    "kind": "invalid",
                    "message": "Invalid request: " + "; ".join(problems),
                }
            },
        )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(notebooks_router)
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
