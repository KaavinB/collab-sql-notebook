"""Validating AI-written SQL with EXPLAIN on a query worker, and the schema context.

These start real worker processes on a small test database.
"""

from collections.abc import AsyncIterator
from pathlib import Path

import duckdb
import pytest

from notebook_api.ai import context as context_module
from notebook_api.ai.context import (
    PARTIAL_RETRY_SECONDS,
    SCHEMA_MAX_CHARS,
    ColumnInfo,
    SchemaCache,
    TableInfo,
    duckdb_schema_context,
    render,
)
from notebook_api.ai.pipeline import AssistantUnavailableError
from notebook_api.ai.validate import DuckDbValidator
from notebook_api.query.engine import EngineLimits, QueryResult, explain, open_connection
from notebook_api.query.runner import QueryFailedError, QueryRunner
from notebook_api.query.validate import PreparedQuery

pytestmark = pytest.mark.anyio

LIMITS = EngineLimits(
    memory_limit_mb=256,
    process_memory_cap_mb=1024,
    threads=1,
    max_spill_size_mb=100,
    timeout_seconds=0.5,
    row_limit=100,
    max_result_bytes=1_000_000,
)
# Takes many seconds to run (a triple cross join), but plans instantly.
SLOW_TO_RUN = "SELECT sum(a.i * b.i) FROM nums a, nums b, nums c"
# Slow to plan: the optimizer folds the constant expression while planning,
# building and hashing six 100 MB strings one after another (one at a time
# stays well under the 1024 MB memory cap the workers get on Linux).
SLOW_TO_PLAN = "SELECT " + " || ".join(f"md5(repeat('{c}', 100000000))" for c in "uvwxyz")


def write_ai_test_db(path: Path) -> Path:
    with duckdb.connect(str(path)) as con:
        con.execute("CREATE TABLE nums AS SELECT range AS i FROM range(10000)")
        con.execute("CREATE TABLE trips (fare_amount DOUBLE, borough VARCHAR, note VARCHAR)")
        con.execute(
            "INSERT INTO trips VALUES (12.5, 'Queens', NULL), (12.5, 'Queens', NULL), "
            "(7.0, 'Manhattan', ?), (3.0, 'Bronx', 'x'), (1.0, 'Brooklyn', 'y')",
            ["a very long note " * 10],
        )
        con.execute("COMMENT ON TABLE trips IS 'One row per trip.'")
        con.execute("COMMENT ON COLUMN trips.fare_amount IS 'Fare in USD.'")
        con.execute("CREATE VIEW cheap_trips AS SELECT * FROM trips WHERE fare_amount < 5")
    return path


@pytest.fixture(scope="module")
def ai_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return write_ai_test_db(tmp_path_factory.mktemp("aidb") / "ai.duckdb")


@pytest.fixture
async def runner(ai_db: Path, tmp_path: Path) -> AsyncIterator[QueryRunner]:
    pool = QueryRunner(ai_db, tmp_path / "spill", LIMITS, workers=1, queue_timeout_seconds=5.0)
    await pool.start()
    yield pool
    await pool.close()


# --- EXPLAIN in the engine and the runner --------------------------------------------


def test_engine_explain_plans_without_running(ai_db: Path, tmp_path: Path) -> None:
    con = open_connection(ai_db, tmp_path, LIMITS)
    # Running it would hit the timeout (see the runner test below); planning doesn't.
    explain(con, PreparedQuery(sql=SLOW_TO_RUN), LIMITS)
    with pytest.raises(duckdb.BinderException):
        explain(con, PreparedQuery(sql="SELECT nope FROM trips"), LIMITS)
    con.close()


async def test_runner_explain_checks_without_running(runner: QueryRunner) -> None:
    with pytest.raises(QueryFailedError) as ran:
        await runner.run(SLOW_TO_RUN)
    assert ran.value.kind == "timeout"
    await runner.explain(SLOW_TO_RUN)  # no timeout: nothing was executed
    # The worker is still healthy and still runs queries.
    result = await runner.run("SELECT count(*) AS n FROM trips")
    assert result["rows"] == [[5]]


async def test_the_worker_refuses_an_unknown_mode(runner: QueryRunner) -> None:
    with pytest.raises(QueryFailedError) as raised:
        await runner._call("SELECT 1", "drop")  # type: ignore[arg-type]
    assert (raised.value.kind, str(raised.value)) == ("error", "Bad request.")
    assert (await runner.run("SELECT 1 AS x"))["rows"] == [[1]]


async def test_runner_explain_reports_duckdb_errors(runner: QueryRunner) -> None:
    with pytest.raises(QueryFailedError) as raised:
        await runner.explain("SELECT nope FROM trips")
    assert raised.value.kind == "error"
    assert "nope" in str(raised.value)


# --- the validator ----------------------------------------------------------------


async def test_a_valid_query_passes(runner: QueryRunner) -> None:
    assert await DuckDbValidator(runner).validate("SELECT borough FROM trips") is None


async def test_an_unknown_column_gives_a_short_error(runner: QueryRunner) -> None:
    error = await DuckDbValidator(runner).validate("SELECT nope FROM trips")
    assert error is not None
    assert error.startswith("Binder Error")
    assert "nope" in error
    assert "LINE 1" not in error  # the excerpt of the regenerated statement is dropped


@pytest.mark.parametrize(
    "sql", ["DELETE FROM trips", "DESCRIBE trips", "PIVOT trips ON borough", "SELECT 1; SELECT 2"]
)
async def test_a_rejected_statement_gives_the_parser_error(runner: QueryRunner, sql: str) -> None:
    error = await DuckDbValidator(runner).validate(sql)
    assert error is not None
    assert "SELECT" in error or "one statement" in error


async def test_slow_planning_times_out(runner: QueryRunner) -> None:
    error = await DuckDbValidator(runner).validate(SLOW_TO_PLAN)
    assert error is not None and "seconds" in error
    # The pool recovers (a worker that overran is replaced).
    assert await DuckDbValidator(runner).validate("SELECT 1") is None


async def test_an_overlong_query_is_refused_before_the_engine() -> None:
    class Never:
        async def explain(self, sql: str) -> None:
            raise AssertionError("must not be called")

    error = await DuckDbValidator(Never()).validate("SELECT " + "1," * 20_000 + "1")
    assert error is not None and "longer than" in error


@pytest.mark.parametrize("kind", ["busy", "crashed"])
async def test_an_engine_failure_is_not_a_validation_error(kind: str) -> None:
    class Failing:
        async def explain(self, sql: str) -> None:
            raise QueryFailedError(kind, "nope")  # type: ignore[arg-type]

    with pytest.raises(AssistantUnavailableError):
        await DuckDbValidator(Failing()).validate("SELECT 1")


async def test_server_paths_are_removed_from_errors(tmp_path: Path) -> None:
    db_file = tmp_path / "data" / "taxi.duckdb"

    class Leaky:
        async def explain(self, sql: str) -> None:
            raise QueryFailedError(
                "error", f'IO Error: Cannot open "{db_file}" or "{tmp_path / "data" / "spill"}"'
            )

    error = await DuckDbValidator(Leaky(), [db_file, db_file.parent]).validate("SELECT 1")
    assert error is not None
    assert str(tmp_path) not in error
    assert error.count("<server path>") == 2


# --- the schema context ---------------------------------------------------------------


async def test_the_schema_context_lists_tables_columns_types_comments_and_samples(
    runner: QueryRunner,
) -> None:
    schema = await duckdb_schema_context(runner, row_limit=5000)
    text = schema.text
    assert schema.dialect == "duckdb"
    assert 'Table trips (about 5 rows): "One row per trip."' in text
    assert '  - fare_amount DOUBLE; comment: "Fare in USD."; sample values: 12.5, 7.0, 3.0' in text
    # Distinct, non-null, at most three, strings as JSON literals.
    assert 'borough VARCHAR; sample values: "Queens", "Manhattan", "Bronx"' in text
    assert "Table cheap_trips" in text  # views too
    assert "Table nums" in text
    # Long strings are cut.
    note_line = next(line for line in text.splitlines() if "a very long note" in line)
    assert "…" in note_line and len(note_line) < 200
    assert "capped at 5000 rows" in text


def test_the_schema_is_bounded() -> None:
    columns = [ColumnInfo(f"col_{i}", "VARCHAR", None, ['"' + "v" * 38 + '"']) for i in range(20)]
    tables = [TableInfo(f"table_{i}", 10, None, list(columns)) for i in range(60)]
    text = render(tables, "Notes.", SCHEMA_MAX_CHARS)
    assert len(text) <= SCHEMA_MAX_CHARS
    assert "sample values" not in text  # samples go first
    assert "more tables are not shown" in text
    small = render(tables[:2], "Notes.", SCHEMA_MAX_CHARS)
    assert "sample values" in small and "not shown" not in small


async def test_the_schema_is_read_once_and_kept(runner: QueryRunner) -> None:
    calls: list[str] = []

    class Counting:
        async def run(self, sql: str) -> QueryResult:
            calls.append(sql)
            return await runner.run(sql)

    cache = SchemaCache(Counting(), row_limit=100)
    first = await cache.get()
    count = len(calls)
    assert await cache.get() is first
    assert len(calls) == count


async def test_a_schema_read_failure_is_not_cached() -> None:
    class Busy:
        def __init__(self) -> None:
            self.calls = 0

        async def run(self, sql: str) -> QueryResult:
            self.calls += 1
            raise QueryFailedError("busy", "busy")

    busy = Busy()
    cache = SchemaCache(busy, row_limit=100)
    for _ in range(2):
        with pytest.raises(AssistantUnavailableError):
            await cache.get()
    assert busy.calls == 2


class _SamplesFail:
    """Wraps the runner; the sample query of `table` fails while `failing` is set."""

    def __init__(self, runner: QueryRunner, table: str) -> None:
        self.runner = runner
        self.table = table
        self.failing = True
        self.calls = 0

    async def run(self, sql: str) -> QueryResult:
        self.calls += 1
        if self.failing and f'FROM "{self.table}" LIMIT' in sql:
            raise QueryFailedError("timeout", "too slow")
        return await self.runner.run(sql)


async def test_a_failed_sample_query_drops_only_that_tables_samples(runner: QueryRunner) -> None:
    schema = await duckdb_schema_context(_SamplesFail(runner, "trips"), row_limit=100)
    trips = schema.text[schema.text.index("Table trips") :]
    assert "  - borough VARCHAR\n" in trips  # listed, without samples
    assert "sample values" in schema.text  # other tables keep theirs


async def test_a_partial_schema_is_read_again_later(runner: QueryRunner) -> None:
    now = [0.0]
    source = _SamplesFail(runner, "trips")
    cache = SchemaCache(source, row_limit=100, clock=lambda: now[0])
    partial = await cache.get()
    assert await cache.get() is partial  # kept for a while
    source.failing = False
    now[0] = PARTIAL_RETRY_SECONDS + 1
    complete = await cache.get()
    assert complete is not partial and '"Queens"' in complete.text
    calls = source.calls
    now[0] = 10_000.0
    assert await cache.get() is complete  # a complete schema is kept for good
    assert source.calls == calls


async def test_tables_past_the_limit_are_counted_in_a_note(
    runner: QueryRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(context_module, "MAX_TABLES", 1)
    schema = await duckdb_schema_context(runner, row_limit=100)
    assert schema.text.count("Table ") == 1
    assert "(2 more tables are not shown.)" in schema.text  # ai.duckdb has three
