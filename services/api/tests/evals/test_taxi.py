import asyncio
from collections.abc import Iterator
from pathlib import Path

import pytest

from notebook_api.evals.cli import DEFAULT_TAXI_QUESTIONS
from notebook_api.evals.taxi import (
    DuckDbExecutor,
    TaxiQuestionsError,
    TaxiSetupError,
    TaxiTarget,
    check_gold_sql,
    default_taxi_wiring,
    load_taxi_file,
    load_taxi_questions,
    scored_questions,
)
from tests.evals.helpers import FakeTaxiWiring, write_taxi_db

ONE = """
[[questions]]
id = "trips-total"
question = "How many trips are there?"
gold_sql = "SELECT count(*) FROM trips"
difficulty = "simple"
"""


@pytest.fixture
def taxi_db(tmp_path: Path) -> Path:
    return write_taxi_db(tmp_path / "taxi.duckdb")


@pytest.fixture
def executor(taxi_db: Path) -> Iterator[DuckDbExecutor]:
    ex = DuckDbExecutor(taxi_db, timeout_seconds=5, row_cap=100)
    yield ex
    ex.close()


def write(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "questions.toml"
    path.write_text(text)
    return path


def test_the_shipped_file_has_its_examples_and_the_real_questions(
    executor: DuckDbExecutor,
) -> None:
    questions = load_taxi_questions(DEFAULT_TAXI_QUESTIONS)
    examples = [q for q in questions if q.example]
    assert [q.id for q in examples] == ["example-trips-per-borough", "example-average-tip-share"]
    assert len(scored_questions(questions)) == 50
    # The examples' gold SQL runs on the real column names (this tiny test
    # database has only those; `pnpm eval check-taxi` runs every question's
    # gold SQL on the real taxi.duckdb).
    check_gold_sql(examples, executor)


def test_loads_a_question(tmp_path: Path) -> None:
    [question] = load_taxi_questions(write(tmp_path, ONE))
    assert question.id == "trips-total"
    assert question.example is False and question.notes == ""
    assert question.to_eval_question().suite == "taxi"


@pytest.mark.parametrize(
    ("text", "message"),
    [
        (ONE + ONE, "duplicate id"),
        (
            ONE + ONE.replace("trips-total", "other").replace("How many", "how  MANY"),
            "repeats the question",
        ),
        (ONE.replace('difficulty = "simple"', 'difficulty = "easy"'), "difficulty"),
        (ONE.replace('"trips-total"', '"Trips Total"'), "id must be"),
        (ONE.replace('"trips-total"', '"../x"'), "id must be"),
        (ONE + 'answer = "42"\n', "unknown fields"),
        (ONE.replace('gold_sql = "SELECT count(*) FROM trips"\n', ""), "gold_sql"),
        (ONE + "example = 1\n", "example must be"),
        (ONE.replace("How many trips are there?", "x" * 2001), "longer than"),
        ("questions = 3\n", "array of tables"),
        ("other = 1\n", "unknown top-level"),
        ("[[questions]\n", "not valid TOML"),
    ],
)
def test_malformed_files_are_refused(tmp_path: Path, text: str, message: str) -> None:
    with pytest.raises(TaxiQuestionsError, match=message):
        load_taxi_questions(write(tmp_path, text))


def test_a_missing_file_is_a_clear_error(tmp_path: Path) -> None:
    with pytest.raises(TaxiQuestionsError, match="can't read"):
        load_taxi_questions(tmp_path / "nope.toml")


def test_gold_sql_that_does_not_run_is_refused(tmp_path: Path, executor: DuckDbExecutor) -> None:
    broken = ONE + ONE.replace("trips-total", "bad").replace(
        "How many trips are there?", "Broken?"
    ).replace("count(*) FROM trips", "nope FROM trips")
    questions = load_taxi_questions(write(tmp_path, broken))
    with pytest.raises(TaxiQuestionsError, match="bad: error"):
        check_gold_sql(questions, executor)


def test_gold_sql_must_be_a_read_only_query(tmp_path: Path, executor: DuckDbExecutor) -> None:
    text = ONE.replace("SELECT count(*) FROM trips", "DELETE FROM trips")
    questions = load_taxi_questions(write(tmp_path, text))
    with pytest.raises(TaxiQuestionsError, match="Only SELECT"):
        check_gold_sql(questions, executor)


def test_executor_returns_sets_of_hashable_rows(executor: DuckDbExecutor) -> None:
    outcome = executor.execute("SELECT tags FROM trips")
    assert outcome.status == "ok"
    assert outcome.rows == frozenset({(("a",),), (("b",),), (("a", "b"),)})
    assert executor.execute("SELECT payment_type FROM trips").rows == frozenset({(1,), (2,)})


def test_executor_is_locked_down_like_the_notebook(
    executor: DuckDbExecutor, tmp_path: Path
) -> None:
    secret = tmp_path / "secret.csv"
    secret.write_text("a\n1\n")
    outcome = executor.execute(f"SELECT * FROM read_csv('{secret}')")
    assert outcome.status == "error"
    assert executor.execute("SET threads = 64").status == "error"


def test_executor_row_cap_and_timeout(taxi_db: Path) -> None:
    ex = DuckDbExecutor(taxi_db, timeout_seconds=0.05, row_cap=2)
    try:
        assert ex.execute("SELECT * FROM trips").status == "too_many_rows"
        slow = ex.execute("SELECT count(*) FROM range(100000000) a, range(1000000) b")
        assert slow.status == "timeout"
    finally:
        ex.close()


def test_taxi_target_uses_the_ai_wiring(executor: DuckDbExecutor) -> None:
    wiring = FakeTaxiWiring()
    target = TaxiTarget(executor, wiring)

    async def go() -> None:
        assert (await target.schema("taxi")).dialect == "duckdb"
        await target.schema("taxi")
        assert await target.validator("taxi").validate("SELECT 1") is None
        assert (await target.execute("taxi", "SELECT 1")).status == "ok"

    asyncio.run(go())
    assert wiring.schema_calls == 1  # built once per run


def test_questions_asking_at_once_share_one_schema_read(executor: DuckDbExecutor) -> None:
    wiring = FakeTaxiWiring()  # its schema_context suspends, like a real read
    target = TaxiTarget(executor, wiring)

    async def go() -> None:
        schemas = await asyncio.gather(*(target.schema("taxi") for _ in range(4)))
        assert len({id(schema) for schema in schemas}) == 1

    asyncio.run(go())
    assert wiring.schema_calls == 1


def test_the_default_wiring_refuses_a_schema_missing_sample_values(
    query_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A schema that lost some tables' samples isn't what the assistant sends.
    from notebook_api.ai import context
    from notebook_api.ai.pipeline import SchemaContext as Schema

    async def partial(runner: object, *, row_limit: int) -> context.SchemaRead:
        return context.SchemaRead(Schema(dialect="duckdb", text="t"), complete=False)

    monkeypatch.setattr(context, "read_schema_context", partial)

    async def go() -> None:
        wiring = default_taxi_wiring(query_db)
        try:
            with pytest.raises(TaxiSetupError, match="sample values"):
                await wiring.schema_context()
        finally:
            await wiring.aclose()

    asyncio.run(go())


def test_the_default_wiring_uses_its_own_spill_directory(query_db: Path, tmp_path: Path) -> None:
    # Starting a pool deletes stale worker-* directories under its spill root;
    # the eval must never do that to a dev API's.
    shared = query_db.parent / "spill"
    shared.mkdir(exist_ok=True)
    live = shared / "worker-live"
    live.mkdir(exist_ok=True)

    async def go() -> None:
        wiring = default_taxi_wiring(query_db)
        own = wiring._spill
        try:
            await wiring.schema_context()
            assert own.is_dir() and own != shared
        finally:
            await wiring.aclose()
        assert not own.exists()

    asyncio.run(go())
    assert live.is_dir()


def test_the_default_wiring_is_the_assistants_own_schema_and_validator(query_db: Path) -> None:
    # The taxi suite asks the way the notebook's assistant does: its schema
    # text (with sample values) and its validator (SELECT-only, then EXPLAIN
    # on a query worker), on a pool it starts on first use and stops at the end.
    async def go() -> None:
        wiring = default_taxi_wiring(query_db)
        try:
            schema = await wiring.schema_context()
            assert schema.dialect == "duckdb"
            assert "nums" in schema.text
            validator = wiring.validator()
            assert await validator.validate("SELECT i FROM nums") is None
            error = await validator.validate("SELECT nope FROM nums")
            assert error is not None and "nope" in error
            assert str(query_db) not in error  # server paths are removed
            assert await validator.validate("DROP TABLE nums") is not None
        finally:
            await wiring.aclose()

    asyncio.run(go())


def test_invalid_settings_are_reported_without_their_values(
    query_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret = "FAKE-short-secret-xyz"  # noqa: S105 (a fake, too short: 32 characters needed)
    monkeypatch.setenv("AUTH_SECRET", secret)
    with pytest.raises(TaxiSetupError) as raised:
        default_taxi_wiring(query_db)
    assert "auth_secret" in str(raised.value)
    assert secret not in str(raised.value)


def test_a_schema_that_cannot_be_read_is_a_setup_error(
    query_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from notebook_api.ai import context
    from notebook_api.ai.pipeline import AssistantUnavailableError

    async def unreadable(runner: object, *, row_limit: int) -> context.SchemaRead:
        raise AssistantUnavailableError("Couldn't read the database's schema.")

    monkeypatch.setattr(context, "read_schema_context", unreadable)

    async def go() -> None:
        wiring = default_taxi_wiring(query_db)
        try:
            with pytest.raises(TaxiSetupError, match="couldn't read the taxi schema"):
                await wiring.schema_context()
        finally:
            await wiring.aclose()

    asyncio.run(go())


def test_the_file_can_say_who_wrote_it(tmp_path: Path) -> None:
    questions, written_by = load_taxi_file(write(tmp_path, 'written_by = " Someone "\n' + ONE))
    assert written_by == "Someone" and len(questions) == 1
    assert load_taxi_file(write(tmp_path, ONE))[1] is None
    for bad in ('written_by = ""\n', "written_by = 3\n", f'written_by = "{"x" * 201}"\n'):
        with pytest.raises(TaxiQuestionsError, match="written_by"):
            load_taxi_file(write(tmp_path, bad + ONE))


def test_the_shipped_file_names_who_wrote_it() -> None:
    written_by = load_taxi_file(DEFAULT_TAXI_QUESTIONS)[1]
    assert written_by is not None and "Codex" in written_by


# The real dataset, when it has been built (`pnpm ingest`); not every
# checkout has it, so this test skips without it.
REAL_TAXI_DB = Path(__file__).resolve().parents[4] / "data" / "taxi.duckdb"


@pytest.mark.skipif(not REAL_TAXI_DB.is_file(), reason="data/taxi.duckdb not built")
def test_every_shipped_gold_query_runs_on_the_real_data() -> None:
    questions = load_taxi_questions(DEFAULT_TAXI_QUESTIONS)
    real = DuckDbExecutor(REAL_TAXI_DB, timeout_seconds=60, row_cap=1_000_000)
    try:
        check_gold_sql(questions, real)
    finally:
        real.close()
