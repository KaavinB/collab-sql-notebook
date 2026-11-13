"""Alembic environment. Migrations run synchronously with the psycopg driver."""

import os

from alembic import context
from sqlalchemy import create_engine, pool

from notebook_api.db.models import Base

config = context.config
target_metadata = Base.metadata


def _database_url() -> str:
    # Tests pass the URL through the Alembic config; otherwise use DATABASE_URL.
    url = config.get_main_option("sqlalchemy.url") or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set (see .env.example)")
    return url


def run_migrations_offline() -> None:
    context.configure(url=_database_url(), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(_database_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
