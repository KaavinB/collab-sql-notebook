"""Text-to-SQL with validation and repair: the AI assistant's core.

Given a question and a schema (tables, columns, types and a few sample values
per column), ask the model for one query, validate it against the target
database (parse, then EXPLAIN), and if it fails, send the error back and ask
for a corrected query, up to `max_repairs` more times. The same code serves
the notebook (DuckDB) and the evaluation harness (BIRD's SQLite databases):
the dialect, schema and validator are passed in.

The first attempt is the answer the assistant would give without the repair
loop, so one run measures both with and without it.
"""

from dataclasses import dataclass
from typing import Literal, Protocol

from notebook_api.ai import prompts
from notebook_api.ai.extract import clip, extract, plain_text

Dialect = Literal["duckdb", "sqlite"]


@dataclass(frozen=True)
class SchemaContext:
    dialect: Dialect
    text: str  # rendered schema: tables, columns, types, a few sample values per column


class Validator(Protocol):
    async def validate(self, sql: str) -> str | None:
        """None if `sql` parses and plans (EXPLAIN) on the target database; else a short error."""
        ...


@dataclass(frozen=True)
class ModelReply:
    text: str
    input_tokens: int
    output_tokens: int
    stop_reason: str | None
    # The model that produced the reply, when the client knows it. It differs
    # from the requested model when a refusal was retried on a fallback model.
    model: str | None = None
    # How many of `input_tokens` were written to / read from the prompt cache
    # (they're priced differently; `input_tokens` is the total read). None
    # when the client doesn't know (fakes, older records).
    cache_write_tokens: int | None = None
    cache_read_tokens: int | None = None


class ModelClient(Protocol):
    async def complete(self, *, system: str, user: str, max_tokens: int) -> ModelReply: ...


@dataclass(frozen=True)
class Attempt:
    sql: str | None  # extracted SQL (None if the reply had none)
    error: str | None  # validation error for this attempt (None = valid)
    input_tokens: int
    output_tokens: int
    model: str | None = None  # the model that answered (ModelReply.model)


@dataclass(frozen=True)
class GenerationResult:
    sql: str | None  # final SQL (the last attempt's); None if no attempt produced SQL
    valid: bool  # the final SQL passed validation
    explanation: str  # one or two sentences shown to the user
    attempts: list[Attempt]  # the first attempt is the answer without the repair loop


class AssistantUnavailableError(Exception):
    """The model API or the validator couldn't do its part (not the model's answer being wrong).

    Raised by ModelClient and Validator implementations for failures such as
    rate limits, server errors, lost connections or a busy query engine. The
    message is safe to show users. `attempts` holds the attempts completed
    before the failure, so they can still be logged.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message
        self.attempts: list[Attempt] = []


# Claude Haiku 5.5 thinks adaptively by default and its thinking counts
# toward max_tokens. An answer itself (a query and two sentences) is a few
# hundred tokens; the cap leaves room for thinking while bounding what one
# runaway reply can cost and how long it can take. A bound, not a measurement:
# a reply that hits it is treated as cut off (see below).
MAX_OUTPUT_TOKENS = 8000
# Shown to people next to the suggestion.
EXPLANATION_MAX_CHARS = 600
EXPLAIN_MAX_CHARS = 1200
# Matches what a cell accepts (query.validate.MAX_SQL_CHARS); repeated here so
# the pipeline stays independent of the notebook's query package.
MAX_SQL_CHARS = 20_000

REFUSED = "The AI assistant declined this request."
CUT_OFF = "The answer was cut off before it finished. Keep the query and explanation shorter."
NO_SQL = "The answer had no ```sql code block with a query in it."
TOO_LONG = f"The query is longer than {MAX_SQL_CHARS} characters."
NO_QUERY = "The AI assistant didn't come up with a query."
NO_EXPLANATION = "The AI assistant didn't give an explanation."
DEFAULT_EXPLANATION = "The AI assistant suggested this query."

# Stop reasons meaning the reply ended before the model finished it. A cut-off
# reply may hold half a query that happens to parse, so nothing in it is used.
_CUT_OFF_REASONS = frozenset({"max_tokens", "model_context_window_exceeded"})


async def generate_sql(
    *,
    question: str,
    schema: SchemaContext,
    validator: Validator,
    client: ModelClient,
    max_repairs: int = 2,
    evidence: str | None = None,
    max_output_tokens: int = MAX_OUTPUT_TOKENS,
    progress: list[Attempt] | None = None,
) -> GenerationResult:
    """Write a query answering `question`, validated and repaired up to `max_repairs` times.

    `max_output_tokens` is each model call's output cap, adaptive thinking
    included; a reply that reaches it is recorded with the error CUT_OFF.
    `progress`, if given, gets each attempt as soon as it's complete, so a
    caller that stops the work part-way (a deadline) still knows what was tried.
    """
    return await _write_query(
        task=prompts.generate_task(question, evidence),
        schema=schema,
        validator=validator,
        client=client,
        max_repairs=max_repairs,
        max_output_tokens=max_output_tokens,
        progress=progress,
    )


async def fix_sql(
    *,
    sql: str,
    error: str,
    schema: SchemaContext,
    validator: Validator,
    client: ModelClient,
    max_repairs: int = 2,
    max_output_tokens: int = MAX_OUTPUT_TOKENS,
    progress: list[Attempt] | None = None,
) -> GenerationResult:
    """Correct `sql`, which failed with `error`; the correction is validated and repaired.

    `progress` is as for generate_sql.
    """
    return await _write_query(
        task=prompts.fix_task(sql, error),
        schema=schema,
        validator=validator,
        client=client,
        max_repairs=max_repairs,
        max_output_tokens=max_output_tokens,
        progress=progress,
    )


async def explain_sql(
    *,
    sql: str,
    schema: SchemaContext,
    client: ModelClient,
    max_output_tokens: int = MAX_OUTPUT_TOKENS,
    progress: list[Attempt] | None = None,
) -> GenerationResult:
    """Explain `sql` in plain language: one model call, nothing to validate.

    The result has no SQL (and so `valid` is False). The single attempt's
    `error` is None when an explanation came back; otherwise it says why
    not, and so does `explanation`. `progress` is as for generate_sql.
    """
    system = prompts.system_prompt(schema)
    reply = await _complete(client, system, prompts.explain_task(sql), [], max_output_tokens)
    error: str | None = None
    text = ""
    if reply.stop_reason == "refusal":
        error = REFUSED
    elif reply.stop_reason in _CUT_OFF_REASONS:
        error = CUT_OFF
    else:
        text = clip(plain_text(reply.text), EXPLAIN_MAX_CHARS)
        if not text:
            error = NO_EXPLANATION
    attempt = Attempt(
        sql=None,
        error=error,
        input_tokens=reply.input_tokens,
        output_tokens=reply.output_tokens,
        model=reply.model,
    )
    if progress is not None:
        progress.append(attempt)
    return GenerationResult(
        sql=None, valid=False, explanation=text if error is None else error, attempts=[attempt]
    )


async def _write_query(
    *,
    task: str,
    schema: SchemaContext,
    validator: Validator,
    client: ModelClient,
    max_repairs: int,
    max_output_tokens: int,
    progress: list[Attempt] | None,
) -> GenerationResult:
    """Ask for a query, validate it, and on failure feed the error back, up to max_repairs times.

    Each repair is a fresh single-turn request: the original task plus the
    previous attempt's SQL and what was wrong with it. A refusal ends the
    loop at once (asking again won't change it). The result's SQL is the
    most recent query any attempt produced, so an answer that was close but
    never validated is still shown, marked invalid.
    """
    if max_repairs < 0:
        raise ValueError("max_repairs must be 0 or more")
    if max_output_tokens < 1:
        raise ValueError("max_output_tokens must be at least 1")
    system = prompts.system_prompt(schema)
    attempts: list[Attempt] = progress if progress is not None else []
    latest: tuple[str, str, str] | None = None  # (sql, explanation, error) of the newest query
    user = task
    refused = False
    for _ in range(max_repairs + 1):
        reply = await _complete(client, system, user, attempts, max_output_tokens)
        sql: str | None = None
        explanation = ""
        error: str | None
        if reply.stop_reason == "refusal":
            error = REFUSED
            refused = True
        elif reply.stop_reason in _CUT_OFF_REASONS:
            error = CUT_OFF
        else:
            extracted = extract(reply.text)
            sql, explanation = extracted.sql, extracted.explanation
            if sql is None:
                error = NO_SQL
            elif len(sql) > MAX_SQL_CHARS:
                sql, error = None, TOO_LONG
            else:
                error = await _validate(validator, sql, attempts)
        attempts.append(
            Attempt(
                sql=sql,
                error=error,
                input_tokens=reply.input_tokens,
                output_tokens=reply.output_tokens,
                model=reply.model,
            )
        )
        if error is None and sql is not None:
            return GenerationResult(
                sql=sql,
                valid=True,
                explanation=clip(explanation or DEFAULT_EXPLANATION, EXPLANATION_MAX_CHARS),
                attempts=attempts,
            )
        if error is None:  # unreachable: no SQL always comes with an error
            error = NO_SQL
        if sql is not None:
            latest = (sql, explanation, error)
        if refused:
            break
        user = prompts.repair_task(task, sql, error)

    if latest is None:
        return GenerationResult(
            sql=None, valid=False, explanation=REFUSED if refused else NO_QUERY, attempts=attempts
        )
    sql, explanation, error = latest
    note = f"It did not pass validation: {clip(error, 200)}"
    return GenerationResult(
        sql=sql,
        valid=False,
        explanation=clip(f"{explanation or DEFAULT_EXPLANATION} {note}", EXPLANATION_MAX_CHARS),
        attempts=attempts,
    )


async def _complete(
    client: ModelClient, system: str, user: str, attempts: list[Attempt], max_tokens: int
) -> ModelReply:
    try:
        return await client.complete(system=system, user=user, max_tokens=max_tokens)
    except AssistantUnavailableError as error:
        error.attempts = list(attempts)
        raise


async def _validate(validator: Validator, sql: str, attempts: list[Attempt]) -> str | None:
    try:
        return await validator.validate(sql)
    except AssistantUnavailableError as error:
        error.attempts = list(attempts)
        raise
