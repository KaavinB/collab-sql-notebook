from pathlib import Path

import pytest

from tests.fixtures import write_query_test_db, write_zones_csv


@pytest.fixture
def zones_csv(tmp_path: Path) -> Path:
    return write_zones_csv(tmp_path / "taxi_zone_lookup.csv")


@pytest.fixture(scope="session")
def query_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return write_query_test_db(tmp_path_factory.mktemp("querydb") / "test.duckdb")


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
