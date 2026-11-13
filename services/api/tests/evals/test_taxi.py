import asyncio
from collections.abc import Iterator
from pathlib import Path

import pytest

from notebook_api.evals.cli import DEFAULT_TAXI_QUESTIONS
from notebook_api.evals.taxi import (
    DuckDbExecutor,
    TaxiQuestionsError,
    TaxiTarget,
    TaxiWiringUnavailableError,
    check_gold_sql,
    default_taxi_wiring,
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


def test_the_shipped_template_has_only_examples_that_run(executor: DuckDbExecutor) -> None:
    questions = load_taxi_questions(DEFAULT_TAXI_QUESTIONS)
    assert [q.id for q in questions] == ["example-trips-per-borough", "example-average-tip-share"]
    assert all(q.example for q in questions)
    assert scored_questions(questions) == []
    check_gold_sql(questions, executor)  # the examples' gold SQL runs on the real columns


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


def test_default_wiring_says_what_is_missing() -> None:
    with pytest.raises(TaxiWiringUnavailableError, match=r"notebook_api\.ai\.context"):
        default_taxi_wiring()
