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


class ModelClient(Protocol):
    async def complete(self, *, system: str, user: str, max_tokens: int) -> ModelReply: ...


@dataclass(frozen=True)
class Attempt:
    sql: str | None  # extracted SQL (None if the reply had none)
    error: str | None  # validation error for this attempt (None = valid)
    input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class GenerationResult:
    sql: str | None  # final SQL (the last attempt's); None if no attempt produced SQL
    valid: bool  # the final SQL passed validation
    explanation: str  # one or two sentences shown to the user
    attempts: list[Attempt]  # the first attempt is the answer without the repair loop


async def generate_sql(
    *,
    question: str,
    schema: SchemaContext,
    validator: Validator,
    client: ModelClient,
    max_repairs: int = 2,
    evidence: str | None = None,
) -> GenerationResult:
    raise NotImplementedError


async def fix_sql(
    *,
    sql: str,
    error: str,
    schema: SchemaContext,
    validator: Validator,
    client: ModelClient,
    max_repairs: int = 2,
) -> GenerationResult:
    raise NotImplementedError


async def explain_sql(*, sql: str, schema: SchemaContext, client: ModelClient) -> GenerationResult:
    raise NotImplementedError
