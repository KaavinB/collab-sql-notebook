from pathlib import Path

import pytest

from tests.fixtures import write_zones_csv


@pytest.fixture
def zones_csv(tmp_path: Path) -> Path:
    return write_zones_csv(tmp_path / "taxi_zone_lookup.csv")
