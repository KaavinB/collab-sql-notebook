"""The exact dataset files we ingest, pinned by SHA-256.

The checksums were recorded from the files the NYC TLC CDN served on
2026-11-13. If TLC republishes a file, ingest fails loudly instead of silently
building from different data. After reviewing an upstream change, update the
hash here in its own commit.
"""

from dataclasses import dataclass
from datetime import date
from itertools import pairwise

_TLC_CDN = "https://d37ci6vzurychx.cloudfront.net"


@dataclass(frozen=True)
class DatasetFile:
    url: str
    filename: str
    sha256: str


@dataclass(frozen=True)
class TripFile(DatasetFile):
    """One month of trips. `month` is the first day of the month the file covers."""

    month: date


TRIP_FILES: tuple[TripFile, ...] = (
    TripFile(
        url=f"{_TLC_CDN}/trip-data/yellow_tripdata_2024-01.parquet",
        filename="yellow_tripdata_2024-01.parquet",
        sha256="c4d59da7bbc8abaeeeb1727947ee93d9891a71acb42854bd80db1571b2030510",
        month=date(2024, 1, 1),
    ),
    TripFile(
        url=f"{_TLC_CDN}/trip-data/yellow_tripdata_2024-02.parquet",
        filename="yellow_tripdata_2024-02.parquet",
        sha256="c76c43c18c6c6664080dd920baab4928988d5786a6b65980792ca7cd796f9f20",
        month=date(2024, 2, 1),
    ),
    TripFile(
        url=f"{_TLC_CDN}/trip-data/yellow_tripdata_2024-03.parquet",
        filename="yellow_tripdata_2024-03.parquet",
        sha256="2d4cdc8fb96726cdd3803b13b02d2e61e71d45720aff0ebc693a8bdd1f249823",
        month=date(2024, 3, 1),
    ),
)

ZONES_FILE = DatasetFile(
    url=f"{_TLC_CDN}/misc/taxi_zone_lookup.csv",
    filename="taxi_zone_lookup.csv",
    sha256="1a99e105092230f8620f301edcca7f80d3080642ff404d28ed957d3fa222c8ed",
)


def _next_month(month: date) -> date:
    return date(month.year + month.month // 12, month.month % 12 + 1, 1)


def pickup_window(files: tuple[TripFile, ...] = TRIP_FILES) -> tuple[date, date]:
    """The [start, end) pickup range covered by `files`.

    Trips picked up outside it are dropped: the raw files contain a few rows
    with clock errors (pickups dated years earlier). Deriving the window from
    the manifest means adding a month can't silently filter that month out.
    The months must be contiguous, so a gap can't hide inside the range.
    """
    months = sorted(f.month for f in files)
    if not months:
        raise ValueError("no trip files")
    for prev, cur in pairwise(months):
        if cur != _next_month(prev):
            raise ValueError(f"trip months must be contiguous: {prev} then {cur}")
    return months[0], _next_month(months[-1])
