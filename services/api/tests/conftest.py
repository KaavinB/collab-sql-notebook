import os
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy.engine import make_url

from tests.fixtures import write_query_test_db, write_zones_csv

API_ROOT = Path(__file__).resolve().parents[1]

# Captured before the autouse fixture below strips app variables from the
# environment. `pnpm test` loads the repo-root .env, so DATABASE_URL is set.
_TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
_DATABASE_URL = os.environ.get("DATABASE_URL")

_APP_ENV_PREFIXES = ("API_", "QUERY_", "DUCKDB_", "DATABASE_", "SNAPSHOT_")


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep a developer's .env out of the app settings that tests build."""
    for name in list(os.environ):
        if name.startswith(_APP_ENV_PREFIXES):
            monkeypatch.delenv(name)


@pytest.fixture
def zones_csv(tmp_path: Path) -> Path:
    return write_zones_csv(tmp_path / "taxi_zone_lookup.csv")


@pytest.fixture(scope="session")
def query_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return write_query_test_db(tmp_path_factory.mktemp("querydb") / "test.duckdb")


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def require_test_database(url: str) -> str:
    """Refuse any database not named *_test: the fixtures drop its whole schema."""
    name = make_url(url).database or ""
    if not name.endswith("_test"):
        raise ValueError(
            f"Refusing to run tests against database {name!r}: its name must end in "
            "'_test', because the test fixtures drop and recreate every table."
        )
    return url


def _test_database_url() -> str:
    if _TEST_DATABASE_URL:
        return require_test_database(_TEST_DATABASE_URL)
    if not _DATABASE_URL:
        pytest.fail(
            "Database tests need DATABASE_URL or TEST_DATABASE_URL. Run them with "
            "`pnpm test` (which loads .env) after `docker compose up -d`."
        )
    # A separate database next to the dev one, so tests never touch dev data.
    url = make_url(_DATABASE_URL)
    derived = url.set(database=f"{url.database}_test").render_as_string(hide_password=False)
    return require_test_database(derived)


@pytest.fixture(scope="session")
def pg_url() -> str:
    """A migrated, empty test database. Created on first use."""
    url = _test_database_url()
    parsed = make_url(url)
    admin = parsed.set(drivername="postgresql", database="postgres")
    try:
        with psycopg.connect(admin.render_as_string(hide_password=False), autocommit=True) as conn:
            exists = conn.execute(
                "SELECT 1 FROM pg_database WHERE datname = %s", (parsed.database,)
            ).fetchone()
            if not exists:
                conn.execute(f'CREATE DATABASE "{parsed.database}"')
    except psycopg.OperationalError as error:
        pytest.fail(f"Can't reach Postgres for tests ({error}). Run `docker compose up -d`.")

    config = Config(str(API_ROOT / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    # Down to empty and back up: every run starts clean and exercises both paths.
    command.downgrade(config, "base")
    command.upgrade(config, "head")
    return url


@pytest.fixture
def clean_db(pg_url: str) -> Iterator[str]:
    sync_url = make_url(pg_url).set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(sync_url, autocommit=True) as conn:
        conn.execute("TRUNCATE notebooks CASCADE")
    yield pg_url
