import time
from collections.abc import Iterator
from pathlib import Path

import duckdb
import pytest

from notebook_api.query.engine import EngineLimits, QueryTimeoutError, execute, open_connection
from notebook_api.query.validate import PreparedQuery, prepare_query

LIMITS = EngineLimits(
    memory_limit_mb=256,
    process_memory_cap_mb=1024,
    threads=1,
    max_spill_size_mb=100,
    timeout_seconds=5.0,
    row_limit=100,
    max_result_bytes=1_000_000,
)


@pytest.fixture
def con(query_db: Path, tmp_path: Path) -> Iterator[duckdb.DuckDBPyConnection]:
    connection = open_connection(query_db, tmp_path / "spill", LIMITS)
    yield connection
    connection.close()


def _raw(sql: str) -> PreparedQuery:
    # Skips the validator on purpose: these tests check the engine layer alone.
    return PreparedQuery(sql=sql)


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT * FROM read_csv('/etc/passwd')",
        "SELECT * FROM read_text('/etc/hosts')",
        "SELECT * FROM glob('/etc/*')",
        "SELECT * FROM read_parquet('https://example.com/x.parquet')",
        "ATTACH '/tmp/other.duckdb' AS other",
        "COPY nums TO '/tmp/out.csv'",
        "EXPORT DATABASE '/tmp/export'",
        "INSTALL httpfs",
        "LOAD httpfs",
        "CREATE TABLE x AS SELECT 1",
        "INSERT INTO nums VALUES (1)",
        "SET enable_external_access = true",
        "SET memory_limit = '100GB'",
        "SET lock_configuration = false",
        "SET TimeZone = 'America/New_York'",
    ],
)
def test_engine_blocks_escapes_even_without_the_validator(
    con: duckdb.DuckDBPyConnection, sql: str
) -> None:
    with pytest.raises(duckdb.Error):
        execute(con, _raw(sql), LIMITS)


def test_engine_runs_in_utc(con: duckdb.DuckDBPyConnection) -> None:
    result = execute(con, _raw("SELECT current_setting('TimeZone') AS tz"), LIMITS)
    assert result["rows"] == [["UTC"]]


def test_returns_columns_types_and_json_rows(con: duckdb.DuckDBPyConnection) -> None:
    result = execute(con, prepare_query("select * from types", LIMITS.row_limit), LIMITS)
    columns = {c["name"]: c["type"] for c in result["columns"]}
    assert columns["decimal_col"] == "DECIMAL(10,2)"
    assert columns["ts_col"] == "TIMESTAMP"
    assert result["rows"] == [
        [
            1,
            "9007199254740993",
            1.5,
            "nan",
            "12.34",
            "hello",
            None,
            True,
            "2024-01-02",
            "2024-01-02T03:04:05",
            "1:30:00",
            [1, 2],
            {"a": 1},
            {"1": "x"},
            "base64:Af8=",
        ]
    ]
    assert result["truncated"] is False


def test_truncates_at_the_row_limit(con: duckdb.DuckDBPyConnection) -> None:
    result = execute(con, prepare_query("select i from nums order by i", 100), LIMITS)
    assert result["row_count"] == 100
    assert result["truncated"] is True
    assert result["rows"][0] == [0]
    assert result["rows"][-1] == [99]


def test_exactly_row_limit_rows_is_not_truncated(con: duckdb.DuckDBPyConnection) -> None:
    result = execute(con, prepare_query("select i from nums limit 100", 100), LIMITS)
    assert result["row_count"] == 100
    assert result["truncated"] is False


def test_truncates_at_the_byte_cap(con: duckdb.DuckDBPyConnection) -> None:
    limits = EngineLimits(**{**LIMITS.__dict__, "max_result_bytes": 1_000})
    result = execute(con, prepare_query("select repeat('x', 100) from nums", 100), limits)
    assert result["truncated"] is True
    assert 0 < result["row_count"] < 100


def test_interrupts_a_query_that_runs_past_the_timeout(
    con: duckdb.DuckDBPyConnection,
) -> None:
    limits = EngineLimits(**{**LIMITS.__dict__, "timeout_seconds": 0.3})
    slow = prepare_query("select sum(a.i * b.i) from nums a, nums b, nums c", 100)
    started = time.perf_counter()
    with pytest.raises(QueryTimeoutError, match=r"0\.3 seconds"):
        execute(con, slow, limits)
    assert time.perf_counter() - started < 3
    # The connection is still usable afterwards.
    assert execute(con, prepare_query("select 1", 100), LIMITS)["rows"] == [[1]]


def test_reports_query_errors(con: duckdb.DuckDBPyConnection) -> None:
    with pytest.raises(duckdb.BinderException, match="nope"):
        execute(con, prepare_query("select nope from nums", 100), LIMITS)


@pytest.mark.parametrize(
    "setup",
    [
        "CREATE TEMP VIEW nums AS SELECT 'poisoned' AS i",
        "CREATE TEMP TABLE nums AS SELECT 'poisoned' AS i",
        "CREATE TEMP MACRO nums() AS TABLE SELECT 'poisoned' AS i",
        "SET VARIABLE poison = 'poisoned'",
        "PREPARE poison AS SELECT 'poisoned'",
    ],
)
def test_session_state_from_one_query_never_reaches_the_next(
    con: duckdb.DuckDBPyConnection, setup: str
) -> None:
    # Run without the validator, as if a future parser gap let these through.
    execute(con, _raw(setup), LIMITS)
    after = execute(con, _raw("SELECT count(*) FROM nums"), LIMITS)
    assert after["rows"] == [[10000]]
    variable = execute(con, _raw("SELECT getvariable('poison') AS v"), LIMITS)
    assert variable["rows"] == [[None]]
    with pytest.raises(duckdb.Error):
        execute(con, _raw("EXECUTE poison"), LIMITS)


def test_every_query_cursor_runs_in_utc(con: duckdb.DuckDBPyConnection) -> None:
    for _ in range(2):
        result = execute(con, _raw("SELECT current_setting('TimeZone')"), LIMITS)
        assert result["rows"] == [["UTC"]]


@pytest.mark.parametrize(
    ("sql", "expected"),
    [
        # Known limitations of DuckDB's Python conversion, documented in D15.
        ("SELECT INTERVAL '1 month 3 days'", "33 days, 0:00:00"),
        ("SELECT 'infinity'::TIMESTAMP", "9999-12-31T23:59:59.999999"),
    ],
)
def test_known_conversion_limitations(
    con: duckdb.DuckDBPyConnection, sql: str, expected: str
) -> None:
    assert execute(con, _raw(sql), LIMITS)["rows"] == [[expected]]
