"""The taxi suite: hand-written questions about the notebook's own dataset.

Questions live in services/api/evals/taxi_questions.toml, written by a
person (not generated), so the benchmark stays independent of the system it
measures. Loading is strict: unknown fields, bad ids, over-long text and
duplicate ids or questions are refused, and every gold query must run on
taxi.duckdb, opened with the same lockdown as the notebook's query engine
(read-only file, no external access, settings locked) and passed through
the same SQL checks (`prepare_query`).

The schema text and validator for the taxi questions come from the AI
service (the same ones the notebook's assistant uses), through the small
`TaxiAIWiring` interface below, so the eval measures what users get.
"""

import asyncio
import re
import shutil
import tempfile
import threading
import time
import tomllib
from collections.abc import Hashable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import duckdb

from notebook_api.ai.pipeline import SchemaContext, Validator
from notebook_api.evals.bird import DIFFICULTIES
from notebook_api.evals.execution import ExecOutcome, short_error
from notebook_api.evals.runner import EvalQuestion
from notebook_api.query.engine import EngineLimits, open_connection
from notebook_api.query.validate import MAX_SQL_CHARS, QueryRejectedError, prepare_query

NOT_MEASURED = "taxi: not measured yet (no questions in services/api/evals/taxi_questions.toml)"
TAXI_DATABASE = "taxi"

_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_FIELDS = frozenset({"id", "question", "gold_sql", "difficulty", "notes", "example"})
_REQUIRED = ("id", "question", "gold_sql", "difficulty")
MAX_QUESTION_CHARS = 2_000  # the same limit the API puts on a prompt
MAX_NOTES_CHARS = 2_000
MAX_QUESTIONS = 1_000
_MAX_FILE_BYTES = 2 * 1024 * 1024
_FETCH_BATCH_ROWS = 1_000


class TaxiQuestionsError(Exception):
    """The questions file is malformed, or a gold query doesn't run."""


@dataclass(frozen=True)
class TaxiQuestion:
    id: str
    question: str
    gold_sql: str
    difficulty: str
    notes: str
    example: bool  # examples show the format; they are validated but never scored

    def to_eval_question(self) -> EvalQuestion:
        return EvalQuestion(
            id=self.id,
            suite="taxi",
            database=TAXI_DATABASE,
            question=self.question,
            evidence=None,
            gold_sql=self.gold_sql,
            difficulty=self.difficulty,
        )


def load_taxi_questions(path: Path) -> list[TaxiQuestion]:
    """Parse and check the file's structure (no database access)."""
    try:
        if path.stat().st_size > _MAX_FILE_BYTES:
            raise TaxiQuestionsError(f"{path} is too large")
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise TaxiQuestionsError(f"can't read {path}: {error.strerror}") from None
    except (tomllib.TOMLDecodeError, UnicodeDecodeError) as error:
        raise TaxiQuestionsError(f"{path} is not valid TOML: {error}") from None
    extra_top = set(data) - {"questions"}
    if extra_top:
        raise TaxiQuestionsError(f"unknown top-level keys: {', '.join(sorted(extra_top))}")
    entries = data.get("questions", [])
    if not isinstance(entries, list):
        raise TaxiQuestionsError("`questions` must be an array of tables ([[questions]])")
    if len(entries) > MAX_QUESTIONS:
        raise TaxiQuestionsError(f"more than {MAX_QUESTIONS} questions")

    questions: list[TaxiQuestion] = []
    ids: set[str] = set()
    texts: dict[str, str] = {}
    for index, entry in enumerate(entries, start=1):
        question = _parse_entry(entry, index)
        if question.id in ids:
            raise TaxiQuestionsError(f"duplicate id: {question.id!r}")
        ids.add(question.id)
        normalized = " ".join(question.question.casefold().split())
        if normalized in texts:
            raise TaxiQuestionsError(
                f"question {question.id!r} repeats the question of {texts[normalized]!r}"
            )
        texts[normalized] = question.id
        questions.append(question)
    return questions


def _parse_entry(entry: Any, index: int) -> TaxiQuestion:
    where = f"question #{index}"
    if not isinstance(entry, dict):
        raise TaxiQuestionsError(f"{where} is not a table")
    unknown = set(entry) - _FIELDS
    if unknown:
        raise TaxiQuestionsError(f"{where} has unknown fields: {', '.join(sorted(unknown))}")
    for field in _REQUIRED:
        if not isinstance(entry.get(field), str) or not entry[field].strip():
            raise TaxiQuestionsError(f"{where} needs a non-empty string `{field}`")
    qid = entry["id"]
    where = f"question {qid!r}"
    if not _ID.match(qid):
        raise TaxiQuestionsError(
            f"{where}: id must be 1-64 characters of a-z, 0-9, '-' or '_', starting with a "
            "letter or digit"
        )
    if len(entry["question"]) > MAX_QUESTION_CHARS:
        raise TaxiQuestionsError(f"{where}: question is longer than {MAX_QUESTION_CHARS} chars")
    if len(entry["gold_sql"]) > MAX_SQL_CHARS:
        raise TaxiQuestionsError(f"{where}: gold_sql is longer than {MAX_SQL_CHARS} chars")
    if entry["difficulty"] not in DIFFICULTIES:
        raise TaxiQuestionsError(f"{where}: difficulty must be one of {', '.join(DIFFICULTIES)}")
    notes = entry.get("notes", "")
    if not isinstance(notes, str) or len(notes) > MAX_NOTES_CHARS:
        raise TaxiQuestionsError(f"{where}: notes must be a string of at most {MAX_NOTES_CHARS}")
    example = entry.get("example", False)
    if not isinstance(example, bool):
        raise TaxiQuestionsError(f"{where}: example must be true or false")
    return TaxiQuestion(
        id=qid,
        question=entry["question"].strip(),
        gold_sql=entry["gold_sql"].strip(),
        difficulty=entry["difficulty"],
        notes=notes,
        example=example,
    )


def scored_questions(questions: list[TaxiQuestion]) -> list[TaxiQuestion]:
    return [question for question in questions if not question.example]


def _hashable(value: object) -> Hashable:
    # DuckDB returns lists for LIST columns and dicts for STRUCT/MAP ones;
    # sets need hashable rows.
    if isinstance(value, (list, tuple)):
        return tuple(_hashable(item) for item in value)
    if isinstance(value, dict):
        return tuple(sorted((str(key), _hashable(item)) for key, item in value.items()))
    return value


class DuckDbExecutor:
    """Runs gold and predicted SQL on taxi.duckdb, locked down like the notebook.

    It runs in the eval's own process (not the API's worker pool, which
    would need the API running): the database file is read-only, external
    access is off and settings are locked exactly as in the query engine,
    and every query goes through `prepare_query` first. The OS memory cap
    the API's workers add on Linux isn't applied here.
    Queries run one at a time (a lock), which is plenty for ~50 questions.
    """

    def __init__(self, db_path: Path, *, timeout_seconds: float, row_cap: int) -> None:
        self._spill_dir = Path(tempfile.mkdtemp(prefix="eval-duckdb-spill-"))
        self._limits = EngineLimits(
            memory_limit_mb=1024,
            process_memory_cap_mb=2048,  # not enforced in-process; required by the type
            threads=2,
            max_spill_size_mb=2048,
            timeout_seconds=timeout_seconds,
            row_limit=row_cap,
            max_result_bytes=0,  # unused here: rows are compared, not sent anywhere
        )
        self._con = open_connection(db_path, self._spill_dir, self._limits)
        self._lock = threading.Lock()

    def close(self) -> None:
        self._con.close()
        shutil.rmtree(self._spill_dir, ignore_errors=True)

    def execute(self, sql: str) -> ExecOutcome:
        started = time.perf_counter()

        def elapsed() -> float:
            return round((time.perf_counter() - started) * 1000, 3)

        try:
            prepared = prepare_query(sql, self._limits.row_limit)
        except QueryRejectedError as error:
            return ExecOutcome("error", error=short_error(error), duration_ms=elapsed())
        with self._lock:
            cursor = self._con.cursor()
            timer = threading.Timer(self._limits.timeout_seconds, cursor.interrupt)
            timer.start()
            rows: set[tuple[Hashable, ...]] = set()
            count = 0
            try:
                cursor.execute(prepared.sql)
                while batch := cursor.fetchmany(_FETCH_BATCH_ROWS):
                    count += len(batch)
                    if count > self._limits.row_limit:
                        return ExecOutcome(
                            "too_many_rows",
                            row_count=count,
                            error=f"more than {self._limits.row_limit} rows",
                            duration_ms=elapsed(),
                        )
                    rows.update(tuple(_hashable(value) for value in row) for row in batch)
            except duckdb.InterruptException:
                return ExecOutcome(
                    "timeout",
                    error=f"stopped after {self._limits.timeout_seconds:g} seconds",
                    duration_ms=elapsed(),
                )
            except duckdb.Error as error:
                return ExecOutcome("error", error=short_error(error), duration_ms=elapsed())
            finally:
                timer.cancel()
                cursor.close()
        return ExecOutcome("ok", rows=frozenset(rows), row_count=count, duration_ms=elapsed())


def check_gold_sql(questions: list[TaxiQuestion], executor: DuckDbExecutor) -> None:
    """Every gold query (examples included) must run and return a result."""
    problems = []
    for question in questions:
        outcome = executor.execute(question.gold_sql)
        if outcome.status != "ok":
            problems.append(f"{question.id}: {outcome.status}: {outcome.error}")
    if problems:
        raise TaxiQuestionsError("gold SQL that doesn't run:\n  " + "\n  ".join(problems))


class TaxiAIWiring(Protocol):
    """What the taxi suite needs from the AI service (notebook_api.ai).

    schema_context(): the same schema text (with sample values) the
    assistant gets for the notebook's dataset. validator(): the same
    validator the assistant uses (SQL checks, then EXPLAIN on a worker).
    """

    async def schema_context(self) -> SchemaContext: ...

    def validator(self) -> Validator: ...


class TaxiWiringUnavailableError(Exception):
    """The AI service's taxi schema context and validator aren't connected yet."""


def default_taxi_wiring() -> TaxiAIWiring:
    """The AI service's real schema context and validator for taxi.duckdb.

    Connected once notebook_api.ai.context and notebook_api.ai.validate
    exist: return an object with `schema_context()` and `validator()`
    built from them.
    """
    raise TaxiWiringUnavailableError(
        "the taxi suite needs the AI service's DuckDB schema context and validator "
        "(notebook_api.ai.context / notebook_api.ai.validate), which aren't connected "
        "to the eval yet; see evals/taxi.py default_taxi_wiring()"
    )


class TaxiTarget:
    def __init__(self, executor: DuckDbExecutor, wiring: TaxiAIWiring) -> None:
        self._executor = executor
        self._wiring = wiring
        self._schema: SchemaContext | None = None

    async def schema(self, database: str) -> SchemaContext:
        if self._schema is None:
            self._schema = await self._wiring.schema_context()
        return self._schema

    def validator(self, database: str) -> Validator:
        return self._wiring.validator()

    async def execute(self, database: str, sql: str) -> ExecOutcome:
        return await asyncio.to_thread(self._executor.execute, sql)
