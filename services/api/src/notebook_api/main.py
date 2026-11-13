"""FastAPI application factory and dev entry point."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx2
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware

from notebook_api.auth.origin_check import OriginCheckMiddleware
from notebook_api.auth.routes import router as auth_router
from notebook_api.body_limit import BodyLimitMiddleware
from notebook_api.config import Settings
from notebook_api.db.session import create_engine, make_sessionmaker
from notebook_api.errors import install_error_handlers
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


def create_app(
    settings: Settings | None = None,
    oauth_transport: httpx2.AsyncBaseTransport | None = None,
) -> FastAPI:
    """The app. `oauth_transport` replaces the network for OAuth calls (tests)."""
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.settings = settings
        app.state.oauth_transport = oauth_transport
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
    # The middleware added last runs first: CORS, then the Host check, then
    # the Origin check, then the body cap. CORS is outermost so even refusals
    # carry CORS headers and the web app can read their message.
    app.add_middleware(OriginCheckMiddleware, allowed_origins=settings.api_cors_origins)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.api_allowed_hosts)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.api_cors_origins,
        # The session cookie must be sent and accepted on cross-origin calls
        # from the web app. Safe only because origins are listed explicitly.
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type"],
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(auth_router)
    app.include_router(notebooks_router)
    install_error_handlers(app)  # last: it reads the finished route schema
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
