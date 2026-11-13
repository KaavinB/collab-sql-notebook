"""Running the pipeline over the questions, for each model, into a resumable results file.

One run answers every selected question once per model, in two phases:

1. Gold: each question's gold SQL runs once, one query at a time (so a
   query's timeout never depends on how many others run beside it), and its
   outcome, rows included, is cached in gold.jsonl. Every model and every
   resume of the run is scored against the same cached gold result.
2. Answers: for each (model, question) the pipeline is asked for SQL with
   the repair loop on; the first attempt (the answer without repair) and the
   final SQL (the answer with repair) are executed and scored. The
   pipeline's first call is the same call `max_repairs=0` would make, so one
   run measures both.

Each finished (model, question) is appended to results.jsonl as one JSON
line as soon as it's done, so a crash or Ctrl-C loses at most the questions
in flight; re-running the same run skips everything already finished.

Refusals: a client reports a refusal as a reply with stop_reason "refusal"
and the pipeline returns a result for it; that is the model's answer and is
scored (wrong, unless an earlier attempt's SQL stands). Only a service
failure (the API unreachable, rate limited, ...) makes the pipeline raise;
such a question has no answer yet, is recorded as failed, left out of every
rate, reported as unfinished, and retried on resume. If the pipeline raises
after the model had already refused, the refusal is the answer.
"""

import asyncio
import json
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from notebook_api.ai.pipeline import (
    Attempt,
    GenerationResult,
    ModelClient,
    ModelReply,
    SchemaContext,
    Validator,
)
from notebook_api.evals.execution import ExecOutcome, short_error
from notebook_api.evals.rowcodec import decode_rows, encode_rows, normalize_rows
from notebook_api.evals.scoring import is_correct

# Stored SQL is capped at the notebook's own SQL limit.
_MAX_STORED_SQL_CHARS = 20_000

# The pipeline's default cap on output tokens per model call (thinking
# included). The runner passes max_output_tokens to generate_sql only when
# a run asks for a different value, so it works with pipelines whose
# signature doesn't have the parameter yet.
DEFAULT_MAX_OUTPUT_TOKENS = 8000

# The exception the pipeline raises for a service failure. Matched by name so
# the harness doesn't depend on where it's defined.
SERVICE_FAILURE = "AssistantUnavailableError"


@dataclass(frozen=True)
class EvalQuestion:
    id: str  # unique within a suite, e.g. "1471" for BIRD or "busiest-zone" for taxi
    suite: str  # "bird" or "taxi"
    database: str  # which database the target runs it on
    question: str
    evidence: str | None
    gold_sql: str
    difficulty: str


class Target(Protocol):
    """Where a suite's questions run: its schema text, validator and executor."""

    async def schema(self, database: str) -> SchemaContext: ...

    def validator(self, database: str) -> Validator: ...

    async def execute(self, database: str, sql: str) -> ExecOutcome: ...


class GenerateFn(Protocol):
    """The signature of notebook_api.ai.pipeline.generate_sql."""

    async def __call__(
        self,
        *,
        question: str,
        schema: SchemaContext,
        validator: Validator,
        client: ModelClient,
        max_repairs: int = ...,
        evidence: str | None = ...,
    ) -> GenerationResult: ...


class RecordingClient:
    """Wraps a model client and keeps every reply (tokens, stop reason, model).

    Token totals come from here rather than from the pipeline's attempts so
    that every billed reply is counted, including those of a call that
    later failed.
    """

    def __init__(self, inner: ModelClient) -> None:
        self._inner = inner
        self.replies: list[ModelReply] = []

    async def complete(self, *, system: str, user: str, max_tokens: int) -> ModelReply:
        reply = await self._inner.complete(system=system, user=user, max_tokens=max_tokens)
        self.replies.append(reply)
        return reply

    @property
    def refused(self) -> bool:
        return any(reply.stop_reason == "refusal" for reply in self.replies)


def result_key(record: dict[str, Any]) -> tuple[str, str, str]:
    return (str(record.get("model")), str(record.get("suite")), str(record.get("id")))


def _read_json_lines(path: Path) -> list[Any]:
    """Every line that parses; a line cut short by a crash mid-write is skipped."""
    if not path.exists():
        return []
    items: list[Any] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            try:
                items.append(json.loads(line))
            except ValueError:
                continue
    return items


def load_records(path: Path) -> list[dict[str, Any]]:
    """Every well-formed record in a results file, in order."""
    return [
        record
        for record in _read_json_lines(path)
        if isinstance(record, dict) and record.get("status") in ("done", "failed")
    ]


def latest_records(records: Iterable[dict[str, Any]]) -> dict[tuple[str, str, str], dict[str, Any]]:
    """The last record per (model, suite, id), except that "done" is never replaced.

    A question can fail (an API error, say) and succeed on a later resume;
    the success is what counts.
    """
    latest: dict[tuple[str, str, str], dict[str, Any]] = {}
    for record in records:
        key = result_key(record)
        if latest.get(key, {}).get("status") == "done":
            continue
        latest[key] = record
    return latest


class _JsonLinesFile:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = asyncio.Lock()

    async def append(self, record: dict[str, Any]) -> None:
        line = json.dumps(record, ensure_ascii=False, default=str) + "\n"
        async with self._lock:
            await asyncio.to_thread(self._write, line)

    def _write(self, line: str) -> None:
        with self._path.open("a+", encoding="utf-8") as f:
            # If an earlier run died mid-line, start on a fresh line.
            f.seek(0, 2)
            if f.tell() > 0:
                f.seek(f.tell() - 1)
                if f.read(1) != "\n":
                    f.write("\n")
            f.write(line)
            f.flush()


class GoldStore:
    """Gold outcomes for one run, cached in gold.jsonl (rows included)."""

    def __init__(self, path: Path) -> None:
        self._file = _JsonLinesFile(path)
        self._outcomes: dict[tuple[str, str], ExecOutcome] = {}
        for item in _read_json_lines(path):
            try:
                key, outcome = _decode_gold(item)
            except KeyError, TypeError, ValueError:
                continue
            self._outcomes[key] = outcome

    def get(self, question: EvalQuestion) -> ExecOutcome:
        return self._outcomes[(question.suite, question.id)]

    def has(self, question: EvalQuestion) -> bool:
        return (question.suite, question.id) in self._outcomes

    async def ensure(
        self,
        questions: list[EvalQuestion],
        targets: dict[str, Target],
        on_progress: Callable[[int, int, EvalQuestion, ExecOutcome], None] | None = None,
    ) -> None:
        """Run, one at a time, every gold query not cached yet."""
        missing = [q for q in questions if not self.has(q)]
        for index, question in enumerate(missing, start=1):
            target = targets[question.suite]
            outcome = await target.execute(question.database, question.gold_sql)
            if outcome.rows is not None:
                outcome = _with_rows(outcome, normalize_rows(outcome.rows))
            await self._file.append(
                {
                    "suite": question.suite,
                    "id": question.id,
                    "outcome": outcome.to_json(),
                    "rows": encode_rows(outcome.rows) if outcome.rows is not None else None,
                }
            )
            self._outcomes[(question.suite, question.id)] = outcome
            if on_progress is not None:
                on_progress(index, len(missing), question, outcome)


def _decode_gold(item: Any) -> tuple[tuple[str, str], ExecOutcome]:
    meta = item["outcome"]
    rows = decode_rows(item["rows"]) if item["rows"] is not None else None
    outcome = ExecOutcome(
        status=meta["status"],
        rows=rows,
        row_count=int(meta["row_count"]),
        error=meta.get("error"),
        duration_ms=float(meta.get("duration_ms", 0.0)),
    )
    if outcome.status not in ("ok", "error", "timeout", "too_many_rows"):
        raise ValueError("bad status")
    if (outcome.status == "ok") != (rows is not None):
        raise ValueError("rows must be present exactly when the gold query succeeded")
    return (str(item["suite"]), str(item["id"])), outcome


def _with_rows(outcome: ExecOutcome, rows: frozenset[Any]) -> ExecOutcome:
    return ExecOutcome(
        outcome.status,
        rows=rows,
        row_count=outcome.row_count,
        error=outcome.error,
        duration_ms=outcome.duration_ms,
    )


@dataclass
class RunProgress:
    total: int
    finished: int = 0
    failed: int = 0


async def run_eval(
    questions: list[EvalQuestion],
    *,
    models: list[str],
    targets: dict[str, Target],
    clients: dict[str, ModelClient],
    generate: GenerateFn,
    results_path: Path,
    gold_path: Path,
    concurrency: int,
    max_repairs: int,
    max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS,
    on_progress: Callable[[RunProgress, dict[str, Any]], None] | None = None,
    on_gold: Callable[[int, int, EvalQuestion, ExecOutcome], None] | None = None,
) -> RunProgress:
    """Run the gold queries not cached yet, then answer every unfinished (model, question)."""
    if concurrency < 1:
        raise ValueError("concurrency must be at least 1")
    gold = GoldStore(gold_path)
    await gold.ensure(questions, targets, on_gold)

    finished = {
        key
        for key, record in latest_records(load_records(results_path)).items()
        if record["status"] == "done"
    }
    todo = [
        (model, question)
        for model in models
        for question in questions
        if (model, question.suite, question.id) not in finished
    ]
    progress = RunProgress(total=len(todo))
    results = _JsonLinesFile(results_path)
    semaphore = asyncio.Semaphore(concurrency)
    options: dict[str, Any] = {"max_repairs": max_repairs}
    if max_output_tokens != DEFAULT_MAX_OUTPUT_TOKENS:
        options["max_output_tokens"] = max_output_tokens

    async def one(model: str, question: EvalQuestion) -> None:
        async with semaphore:
            record = await _answer(
                question,
                model=model,
                target=targets[question.suite],
                client=clients[model],
                generate=generate,
                gold=gold.get(question),
                options=options,
            )
        await results.append(record)
        progress.finished += 1
        if record["status"] == "failed":
            progress.failed += 1
        if on_progress is not None:
            on_progress(progress, record)

    await asyncio.gather(*(one(model, question) for model, question in todo))
    return progress


async def _answer(
    question: EvalQuestion,
    *,
    model: str,
    target: Target,
    client: ModelClient,
    generate: GenerateFn,
    gold: ExecOutcome,
    options: dict[str, Any],
) -> dict[str, Any]:
    base: dict[str, Any] = {
        "model": model,
        "suite": question.suite,
        "id": question.id,
        "database": question.database,
        "difficulty": question.difficulty,
        "recorded_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "gold": gold.to_json(),
    }
    if gold.status != "ok":
        # Can't be scored, so the model isn't asked (no tokens spent on it).
        return {**base, "status": "done", "gold_excluded": True, "replies": []}

    recorder = RecordingClient(client)
    started = time.perf_counter()
    result: GenerationResult | None = None
    raised: str | None = None
    try:
        schema = await target.schema(question.database)
        kwargs: dict[str, Any] = {
            "question": question.question,
            "schema": schema,
            "validator": target.validator(question.database),
            "client": recorder,
            "evidence": question.evidence or None,
            **options,
        }
        result = await generate(**kwargs)
    except Exception as error:
        raised = f"{type(error).__name__}: {short_error(error)}"
        if not recorder.refused:
            # No answer yet: a service failure (or a bug). Recorded, left out
            # of every rate, and retried when the run is resumed.
            return {
                **base,
                "status": "failed",
                "error": raised,
                "error_kind": "service"
                if type(error).__name__ == SERVICE_FAILURE
                else "unexpected",
                "replies": _replies_json(recorder),
            }
        # The model had refused before the pipeline raised: the refusal is
        # its answer (scored wrong below, with no SQL).
    latency_ms = round((time.perf_counter() - started) * 1000, 1)

    attempts = result.attempts if result is not None else []
    first_sql = attempts[0].sql if attempts else None
    first_valid = bool(attempts) and first_sql is not None and attempts[0].error is None
    # The pipeline's final SQL is the most recent SQL any attempt produced.
    final_sql = result.sql if result is not None else None
    final_valid = result.valid if result is not None and final_sql is not None else False
    first_stop, final_stop = _stop_reasons(attempts, recorder.replies, final_sql)

    first_exec = await _execute(target, question.database, first_sql)
    final_exec = (
        first_exec
        if final_sql == first_sql
        else await _execute(target, question.database, final_sql)
    )
    first_correct = first_exec is not None and is_correct(first_exec, gold)
    final_correct = final_exec is not None and is_correct(final_exec, gold)
    return {
        **base,
        "status": "done",
        "gold_excluded": False,
        "refused": recorder.refused,
        "pipeline_error": raised,
        "latency_ms": latency_ms,
        "attempts": [_attempt_json(attempt) for attempt in attempts],
        "replies": _replies_json(recorder),
        "first": _scored(first_sql, first_valid, first_exec, first_correct, first_stop),
        "final": _scored(final_sql, final_valid, final_exec, final_correct, final_stop),
        "repair_changed_sql": final_sql != first_sql,
    }


def _stop_reasons(
    attempts: list[Attempt], replies: list[ModelReply], final_sql: str | None
) -> tuple[str | None, str | None]:
    """The stop reason of the reply behind the first answer and behind the final one.

    Each attempt is one model call, in order, so attempt i came from reply i.
    The final answer is the latest attempt whose SQL it is; if there's no
    SQL, it's the last reply (e.g. the refusal or cut-off that ended it).
    """
    if not replies:
        return None, None
    first = replies[0].stop_reason
    final_index = len(replies) - 1
    if final_sql is not None and len(attempts) == len(replies):
        matches = [i for i, attempt in enumerate(attempts) if attempt.sql == final_sql]
        if matches:
            final_index = matches[-1]
    return first, replies[final_index].stop_reason


async def _execute(target: Target, database: str, sql: str | None) -> ExecOutcome | None:
    if sql is None:
        return None
    outcome = await target.execute(database, sql)
    if outcome.rows is None:
        return outcome
    # Same round trip as the cached gold rows, so both sides are the same kinds of values.
    return _with_rows(outcome, normalize_rows(outcome.rows))


def _scored(
    sql: str | None,
    valid: bool,
    outcome: ExecOutcome | None,
    correct: bool,
    stop_reason: str | None,
) -> dict[str, Any]:
    return {
        "sql": _clip(sql),
        "valid": valid,
        "exec": outcome.to_json() if outcome is not None else None,
        "correct": correct,
        "stop_reason": stop_reason,
        "refused": stop_reason == "refusal",
        "cut_off": stop_reason == "max_tokens",
    }


def _attempt_json(attempt: Attempt) -> dict[str, Any]:
    return {
        "sql": _clip(attempt.sql),
        "error": attempt.error,
        "input_tokens": attempt.input_tokens,
        "output_tokens": attempt.output_tokens,
        "model": getattr(attempt, "model", None),
    }


def _replies_json(recorder: RecordingClient) -> list[dict[str, Any]]:
    return [
        {
            "input_tokens": reply.input_tokens,
            "output_tokens": reply.output_tokens,
            "stop_reason": reply.stop_reason,
            "model": getattr(reply, "model", None),
        }
        for reply in recorder.replies
    ]


def _clip(sql: str | None) -> str | None:
    if sql is None or len(sql) <= _MAX_STORED_SQL_CHARS:
        return sql
    return sql[:_MAX_STORED_SQL_CHARS]
