"""Build the read-only taxi DuckDB database from verified raw files."""

import secrets
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import duckdb

# Raw TLC column -> our column name, type and description. Renaming to
# snake_case gives users (and the AI in Phase 3) one consistent naming style.
# Descriptions follow the TLC yellow taxi data dictionary and are stored as
# DuckDB column comments, so they travel with the database.
_TRIP_COLUMNS: tuple[tuple[str, str, str, str], ...] = (
    ("VendorID", "vendor_id", "INTEGER", "Provider that supplied the record."),
    ("tpep_pickup_datetime", "pickup_at", "TIMESTAMP", "Meter engaged (local time)."),
    ("tpep_dropoff_datetime", "dropoff_at", "TIMESTAMP", "Meter disengaged (local time)."),
    ("passenger_count", "passenger_count", "INTEGER", "Number of passengers (driver-entered)."),
    ("trip_distance", "trip_distance", "DOUBLE", "Trip distance in miles (taximeter)."),
    (
        "RatecodeID",
        "rate_code_id",
        "INTEGER",
        "Final rate code: 1 standard, 2 JFK, 3 Newark, 4 Nassau/Westchester, "
        "5 negotiated, 6 group ride, 99 unknown.",
    ),
    (
        "store_and_fwd_flag",
        "store_and_fwd_flag",
        "VARCHAR",
        "Y if the trip was stored in the vehicle before sending (no connection), else N.",
    ),
    ("PULocationID", "pickup_location_id", "INTEGER", "Pickup taxi zone (zones.location_id)."),
    ("DOLocationID", "dropoff_location_id", "INTEGER", "Dropoff taxi zone (zones.location_id)."),
    (
        "payment_type",
        "payment_type",
        "INTEGER",
        "1 credit card, 2 cash, 3 no charge, 4 dispute, 5 unknown, 6 voided trip.",
    ),
    ("fare_amount", "fare_amount", "DOUBLE", "Time-and-distance fare in USD."),
    ("extra", "extra", "DOUBLE", "Miscellaneous extras and surcharges in USD."),
    ("mta_tax", "mta_tax", "DOUBLE", "MTA tax in USD."),
    ("tip_amount", "tip_amount", "DOUBLE", "Tip in USD (card tips only; cash tips not recorded)."),
    ("tolls_amount", "tolls_amount", "DOUBLE", "Total tolls paid in USD."),
    ("improvement_surcharge", "improvement_surcharge", "DOUBLE", "Improvement surcharge in USD."),
    ("total_amount", "total_amount", "DOUBLE", "Total charged to riders in USD (excl. cash tips)."),
    ("congestion_surcharge", "congestion_surcharge", "DOUBLE", "NYS congestion surcharge in USD."),
    ("Airport_fee", "airport_fee", "DOUBLE", "Fee for pickups at LaGuardia and JFK in USD."),
)

_ZONE_COLUMNS: tuple[tuple[str, str, str, str], ...] = (
    ("LocationID", "location_id", "INTEGER", "Taxi zone ID."),
    ("Borough", "borough", "VARCHAR", "NYC borough (or EWR for Newark Airport)."),
    ("Zone", "zone", "VARCHAR", "Taxi zone name."),
    ("service_zone", "service_zone", "VARCHAR", "TLC service area (e.g. Yellow Zone, Boro Zone)."),
)


@dataclass(frozen=True)
class BuildReport:
    """Row counts measured during the build (printed by the CLI)."""

    raw_trip_rows: int
    trip_rows: int
    dropped_outside_window: int
    zone_rows: int


def _select_list(columns: tuple[tuple[str, str, str, str], ...]) -> str:
    # Built only from the constant tables above, never from user input.
    return ", ".join(f'CAST("{raw}" AS {typ}) AS {name}' for raw, name, typ, _ in columns)


def _comment_columns(
    con: duckdb.DuckDBPyConnection, table: str, columns: tuple[tuple[str, str, str, str], ...]
) -> None:
    for _, name, _, description in columns:
        # COMMENT ON doesn't accept bound parameters; descriptions are our own
        # constants, with quotes escaped anyway.
        escaped = description.replace("'", "''")
        con.execute(f"COMMENT ON COLUMN {table}.{name} IS '{escaped}'")


def build_database(
    trip_files: list[Path],
    zones_file: Path,
    out_path: Path,
    window_start: date,
    window_end: date,
) -> BuildReport:
    """Build `out_path` from the raw files, replacing any existing database atomically.

    The database is written to a temporary file first and renamed into place
    only after it is complete, so a crash mid-build never leaves a half-built
    database where the API would open it.

    The temporary name is random. It must not be `<out>.tmp`: that is DuckDB's
    default spill directory for `<out>`, which the API creates while running
    large queries. A random name also keeps concurrent builds apart.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_name(f".{out_path.name}.build-{secrets.token_hex(8)}")
    tmp_wal = tmp_path.with_name(tmp_path.name + ".wal")

    try:
        with duckdb.connect(str(tmp_path)) as con:
            files = [str(p) for p in trip_files]
            raw_rows = _scalar(con, "SELECT count(*) FROM read_parquet($files)", {"files": files})
            con.execute(
                f"CREATE TABLE trips AS SELECT {_select_list(_TRIP_COLUMNS)} "  # noqa: S608
                "FROM read_parquet($files) "
                "WHERE tpep_pickup_datetime >= $start AND tpep_pickup_datetime < $end "
                "ORDER BY tpep_pickup_datetime",
                {"files": files, "start": window_start, "end": window_end},
            )
            con.execute(
                f"CREATE TABLE zones AS SELECT {_select_list(_ZONE_COLUMNS)} "  # noqa: S608
                "FROM read_csv($file, header = true) ORDER BY LocationID",
                {"file": str(zones_file)},
            )
            con.execute(
                "COMMENT ON TABLE trips IS 'NYC yellow taxi trips, one row per trip "
                f"(pickups {window_start.isoformat()} to before {window_end.isoformat()}).'"
            )
            con.execute("COMMENT ON TABLE zones IS 'NYC TLC taxi zones, for trips.*_location_id.'")
            _comment_columns(con, "trips", _TRIP_COLUMNS)
            _comment_columns(con, "zones", _ZONE_COLUMNS)

            trip_rows = _scalar(con, "SELECT count(*) FROM trips")
            zone_rows = _scalar(con, "SELECT count(*) FROM zones")
            con.execute("CHECKPOINT")
        tmp_path.replace(out_path)
    finally:
        tmp_path.unlink(missing_ok=True)
        tmp_wal.unlink(missing_ok=True)

    return BuildReport(
        raw_trip_rows=raw_rows,
        trip_rows=trip_rows,
        dropped_outside_window=raw_rows - trip_rows,
        zone_rows=zone_rows,
    )


def _scalar(
    con: duckdb.DuckDBPyConnection, sql: str, params: dict[str, object] | None = None
) -> int:
    row = con.execute(sql, params).fetchone()
    if row is None:
        raise RuntimeError(f"query returned no rows: {sql}")
    return int(row[0])
