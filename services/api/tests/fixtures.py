"""Helpers that write tiny raw files shaped exactly like the real TLC downloads."""

from pathlib import Path

import duckdb

# The raw TLC column names and types, as they appear in the 2024 Parquet files.
RAW_TRIP_SCHEMA = """
    VendorID INTEGER, tpep_pickup_datetime TIMESTAMP, tpep_dropoff_datetime TIMESTAMP,
    passenger_count BIGINT, trip_distance DOUBLE, RatecodeID BIGINT,
    store_and_fwd_flag VARCHAR, PULocationID INTEGER, DOLocationID INTEGER,
    payment_type BIGINT, fare_amount DOUBLE, extra DOUBLE, mta_tax DOUBLE,
    tip_amount DOUBLE, tolls_amount DOUBLE, improvement_surcharge DOUBLE,
    total_amount DOUBLE, congestion_surcharge DOUBLE, Airport_fee DOUBLE
"""


def write_trip_parquet(path: Path, pickups: list[str]) -> Path:
    """Write a Parquet file with one trip per pickup timestamp."""
    with duckdb.connect() as con:
        con.execute(f"CREATE TABLE t ({RAW_TRIP_SCHEMA})")
        for i, pickup in enumerate(pickups):
            con.execute(
                "INSERT INTO t VALUES (2, $p::TIMESTAMP, $p::TIMESTAMP + INTERVAL 10 MINUTE, "
                "1, 1.5, 1, 'N', 132, 236, 1, 10.0, 0.5, 0.5, 2.0, 0.0, 1.0, $total, 2.5, 0.0)",
                {"p": pickup, "total": 14.5 + i},
            )
        con.execute("COPY t TO $path (FORMAT parquet)", {"path": str(path)})
    return path


def write_zones_csv(path: Path) -> Path:
    path.write_text(
        '"LocationID","Borough","Zone","service_zone"\n'
        '1,"EWR","Newark Airport","EWR"\n'
        '132,"Queens","JFK Airport","Airports"\n'
        '236,"Manhattan","Upper East Side North","Yellow Zone"\n'
    )
    return path


def write_query_test_db(path: Path) -> Path:
    """A small database for query tests: numbers plus one row of many types."""
    with duckdb.connect(str(path)) as con:
        con.execute("CREATE TABLE nums AS SELECT range AS i FROM range(10000)")
        con.execute(
            """
            CREATE TABLE types AS SELECT
                1::INTEGER AS int_col,
                9007199254740993::BIGINT AS big_col,
                1.5::DOUBLE AS float_col,
                'nan'::DOUBLE AS nan_col,
                12.34::DECIMAL(10, 2) AS decimal_col,
                'hello' AS text_col,
                NULL::VARCHAR AS null_col,
                TRUE AS bool_col,
                DATE '2024-01-02' AS date_col,
                TIMESTAMP '2024-01-02 03:04:05' AS ts_col,
                INTERVAL 90 MINUTE AS interval_col,
                [1, 2] AS list_col,
                {'a': 1} AS struct_col,
                MAP {1: 'x'} AS map_col,
                '\\x01\\xff'::BLOB AS blob_col
            """
        )
    return path


def exit_immediately(*_args: object) -> None:
    """A worker target that exits before saying hello (for runner startup tests)."""
