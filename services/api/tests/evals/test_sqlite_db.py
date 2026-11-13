import asyncio
import sqlite3
from pathlib import Path

import pytest

from notebook_api.evals import sqlite_db
from notebook_api.evals.execution import ExecOutcome
from notebook_api.evals.sqlite_db import (
    SqliteValidator,
    check_select,
    execute_query,
    open_read_only,
    render_value,
    sqlite_schema_context,
)
from tests.evals.helpers import ENDLESS_SQL, write_shop_db


@pytest.fixture
def shop(tmp_path: Path) -> Path:
    return write_shop_db(tmp_path / "shop.sqlite")


def run(db: Path, sql: str, timeout: float = 5.0, cap: int = 1000) -> ExecOutcome:
    return execute_query(db, sql, timeout_seconds=timeout, row_cap=cap)


def test_results_are_sets_of_rows(shop: Path) -> None:
    outcome = run(shop, "SELECT amount FROM orders")
    assert outcome.status == "ok"
    assert outcome.rows == frozenset({(10.0,), (5.0,), (7.5,)})
    assert outcome.row_count == 4  # fetched rows, before duplicates collapse


def test_errors_are_recorded_not_raised(shop: Path) -> None:
    outcome = run(shop, "SELECT nope FROM customers")
    assert outcome.status == "error"
    assert outcome.error is not None and "nope" in outcome.error


def test_timeout_stops_a_runaway_query(shop: Path) -> None:
    outcome = run(shop, ENDLESS_SQL, timeout=0.2)
    assert outcome.status == "timeout"
    assert outcome.duration_ms < 5000


def test_row_cap(shop: Path) -> None:
    outcome = run(shop, "SELECT * FROM orders", cap=3)
    assert outcome.status == "too_many_rows"
    assert outcome.rows is None


@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO customers VALUES (9, 'x', 'y')",
        "DELETE FROM orders",
        "CREATE TABLE t (a)",
        "ATTACH DATABASE ':memory:' AS other",
        "PRAGMA query_only = OFF",
        "SELECT load_extension('evil')",
    ],
)
def test_execution_connection_only_reads(shop: Path, sql: str) -> None:
    before = shop.read_bytes()
    outcome = run(shop, sql)
    assert outcome.status == "error"
    assert shop.read_bytes() == before


def test_even_the_unrestricted_connection_is_read_only(shop: Path) -> None:
    con = open_read_only(shop, restricted=False)
    try:
        with pytest.raises(sqlite3.OperationalError):
            con.execute("INSERT INTO customers VALUES (9, 'x', 'y')")
    finally:
        con.close()


def test_missing_database_is_an_error(tmp_path: Path) -> None:
    assert run(tmp_path / "nope.sqlite", "SELECT 1").status == "error"
    assert not (tmp_path / "nope.sqlite").exists()  # mode=ro never creates a file


def test_check_select() -> None:
    assert check_select("SELECT 1", "sqlite") is None
    assert check_select("WITH a AS (SELECT 1) SELECT * FROM a", "sqlite") is None
    assert check_select("SELECT 1 UNION SELECT 2", "sqlite") is None
    assert check_select("", "sqlite") == "The query is empty."
    assert check_select("SELECT 1; SELECT 2", "sqlite") == "Write exactly one statement."
    assert check_select("DELETE FROM t", "sqlite") == "Only SELECT queries are allowed."
    assert check_select("PRAGMA table_info(t)", "sqlite") == "Only SELECT queries are allowed."
    assert (check_select("SELECT (", "sqlite") or "").startswith("Could not parse")
    assert check_select("SELECT 1" + " " * 20_001, "sqlite") is not None


def test_validator_parses_then_explains(shop: Path) -> None:
    validator = SqliteValidator(shop)
    assert asyncio.run(validator.validate("SELECT name FROM customers")) is None
    unknown_column = asyncio.run(validator.validate("SELECT nope FROM customers"))
    assert unknown_column is not None and "nope" in unknown_column
    assert asyncio.run(validator.validate("SELECT * FROM missing_table")) is not None
    assert asyncio.run(validator.validate("DROP TABLE customers")) is not None
    # EXPLAIN plans the query without running it: an endless query validates.
    assert asyncio.run(validator.validate(ENDLESS_SQL)) is None


def test_schema_context_lists_tables_columns_keys_and_samples(shop: Path) -> None:
    schema = sqlite_schema_context(shop)
    assert schema.dialect == "sqlite"
    text = schema.text
    assert 'CREATE TABLE "customers"' in text
    assert '"id" INTEGER PRIMARY KEY' in text
    assert "\"city\" TEXT -- e.g. 'London', 'New York', 'Helsinki'" in text
    assert 'FOREIGN KEY ("customer_id") REFERENCES "customers" ("id")' in text
    assert "-- e.g. 10.0, 5.0, 7.5" in text  # distinct values only


def test_schema_context_is_bounded(shop: Path) -> None:
    full = sqlite_schema_context(shop).text
    # Too long with three samples: one sample per column instead.
    fewer = sqlite_schema_context(shop, max_chars=len(full) - 1).text
    assert len(fewer) < len(full)
    assert "\"city\" TEXT -- e.g. 'London'\n" in fewer
    assert "'New York'" not in fewer
    cut = sqlite_schema_context(shop, max_chars=120).text
    assert len(cut) <= 120
    assert "schema cut here" in cut


def test_sample_values_are_single_line_and_truncated() -> None:
    assert render_value("a\nb\tc") == "'a b c'"
    assert render_value("it's") == "'it''s'"
    long = render_value("x" * 100)
    assert long is not None and len(long) == sqlite_db.SAMPLE_MAX_CHARS + 2
    assert long.endswith("…'")
    assert render_value(b"\x00\x01") is None
    assert render_value(3) == "3"


def test_odd_identifiers_are_quoted(tmp_path: Path) -> None:
    path = tmp_path / "odd.sqlite"
    con = sqlite3.connect(path)
    con.execute('CREATE TABLE "my ""table""" ("Free Meal Count (K-12)" REAL)')
    con.execute('INSERT INTO "my ""table""" VALUES (1.5)')
    con.commit()
    con.close()
    text = sqlite_schema_context(path).text
    assert 'CREATE TABLE "my ""table"""' in text
    assert '"Free Meal Count (K-12)" REAL -- e.g. 1.5' in text


def test_schema_text_is_valid_sqlite_ddl(shop: Path) -> None:
    # Sample values live in -- comments after each line's comma, so SQLite
    # itself can read the text back.
    text = sqlite_schema_context(shop).text
    assert "\"name\" TEXT, -- e.g. 'Ada', 'Grace', 'Linus'\n" in text
    con = sqlite3.connect(":memory:")
    con.executescript(text)
    tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master")}
    assert tables == {"customers", "orders"}


def test_composite_keys_render_as_table_constraints(tmp_path: Path) -> None:
    path = tmp_path / "keys.sqlite"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE parent (a INTEGER, b TEXT, PRIMARY KEY (b, a))")
    con.execute(
        "CREATE TABLE child (x INTEGER, y TEXT, FOREIGN KEY (x, y) REFERENCES parent (a, b))"
    )
    con.execute("INSERT INTO parent VALUES (1, 'one')")
    con.commit()
    con.close()
    text = sqlite_schema_context(path).text
    assert 'PRIMARY KEY ("b", "a")' in text
    assert 'FOREIGN KEY ("x", "y") REFERENCES "parent" ("a", "b")' in text
    sqlite3.connect(":memory:").executescript(text)
