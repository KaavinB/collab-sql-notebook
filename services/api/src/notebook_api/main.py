"""FastAPI application factory and dev entry point."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx2
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from notebook_api.ai.client import FAKE_MODEL_NAME, AnthropicModelClient, FakeModelClient
from notebook_api.ai.context import SchemaCache
from notebook_api.ai.pipeline import ModelClient
from notebook_api.ai.routes import router as ai_router
from notebook_api.ai.service import AiService
from notebook_api.ai.validate import DuckDbValidator, notebook_private_paths
from notebook_api.auth.origin_check import OriginCheckMiddleware
from notebook_api.auth.routes import router as auth_router
from notebook_api.body_limit import BodyLimitMiddleware
from notebook_api.config import Settings
from notebook_api.db.session import create_engine, make_sessionmaker
from notebook_api.errors import install_error_handlers
from notebook_api.notebooks.executions import Executions, lock_ttl_seconds
from notebook_api.notebooks.routes import router as notebooks_router
from notebook_api.notebooks.sharing import members_router, share_links_router
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


def build_ai_service(
    settings: Settings,
    sessions: async_sessionmaker[AsyncSession] | None,
    runner: QueryRunner | None,
    model_client: ModelClient | None = None,
) -> AiService | None:
    """The AI assistant, or None (its routes answer 503) if it can't work here.

    It needs the database (requests are logged and suggestions stored), the
    query engine (schema and validation) and a model: `model_client` (tests),
    the fake model (AI_FAKE_MODEL), or Claude with ANTHROPIC_API_KEY.
    """
    if sessions is None or runner is None:
        return None
    model_name: str = settings.ai_model
    # Whether a refused request may be retried on a fallback model: only
    # Claude itself, and only for the models that have one.
    fallbacks = False
    client: ModelClient
    if model_client is not None:
        client = model_client
    elif settings.ai_fake_model:
        client, model_name = FakeModelClient(), FAKE_MODEL_NAME
    elif settings.anthropic_api_key is not None:
        claude = AnthropicModelClient(
            api_key=settings.anthropic_api_key.get_secret_value(),
            model=settings.ai_model,
            effort=settings.ai_effort,
            fallbacks=settings.ai_refusal_fallbacks,
        )
        client, fallbacks = claude, claude.uses_fallbacks
    else:
        return None
    private_paths = notebook_private_paths(runner.db_path, runner.spill_root)
    return AiService(
        sessions,
        client,
        model_name,
        SchemaCache(runner, settings.query_row_limit),
        DuckDbValidator(runner, private_paths),
        max_concurrent=settings.ai_max_concurrent,
        requests_kept_per_notebook=settings.ai_requests_kept_per_notebook,
        # Logged with every request, so results can be compared across settings.
        logged_settings={"effort": settings.ai_effort, "refusal_fallbacks": fallbacks},
    )


def create_app(
    settings: Settings | None = None,
    oauth_transport: httpx2.AsyncBaseTransport | None = None,
    model_client: ModelClient | None = None,
) -> FastAPI:
    """The app. In tests, `oauth_transport` replaces the network for OAuth calls
    and `model_client` replaces the AI model."""
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.settings = settings
        app.state.oauth_transport = oauth_transport
        engine = create_engine(settings.database_url) if settings.database_url else None
        app.state.sessions = make_sessionmaker(engine) if engine else None
        runner = build_query_runner(settings)
        executions: Executions | None = None
        ai: AiService | None = None
        try:
            if runner is not None:
                # Fails startup loudly if the database is missing or a worker
                # can't open it, rather than failing on the first query.
                await runner.start()
            app.state.query_runner = runner
            if runner is not None and app.state.sessions is not None:
                executions = Executions(
                    app.state.sessions,
                    runner,
                    lock_ttl_seconds(settings),
                    runs_kept_per_notebook=settings.query_runs_kept_per_notebook,
                )
            app.state.executions = executions
            ai = build_ai_service(settings, app.state.sessions, runner, model_client)
            app.state.ai = ai
            yield
        finally:
            # AI requests and executions first: each marks its row failed or
            # releases its cell's lock in Postgres, which needs the database
            # engine (and, for AI requests, the query runner) still open.
            if ai is not None:
                await ai.close()
            if executions is not None:
                await executions.close()
            if runner is not None:
                await runner.close()
            if engine is not None:
                await engine.dispose()

    app = FastAPI(title="Collab SQL Notebook API", lifespan=lifespan)
    app.add_middleware(
        BodyLimitMiddleware,
        max_bytes=settings.api_max_body_bytes,
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
    app.include_router(members_router)
    app.include_router(share_links_router)
    app.include_router(ai_router)
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
