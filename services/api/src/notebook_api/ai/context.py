"""The schema the model sees: tables, columns, DuckDB types and a few sample values.

Read from the notebook database through the query runner, so it goes
through the same locked-down, read-only workers as everyone's queries (no
second connection with its own configuration to keep in sync). Built once
per process and kept: the database file is read-only and never changes
while the API runs.

Sample values and comments are data from the database. They're rendered as
JSON literals (quotes and newlines escaped) inside the prompt's <schema>
tag, which the system prompt marks as data, never instructions.

Bounded: at most MAX_TABLES tables, SAMPLES_PER_COLUMN values per column,
each value cut to SAMPLE_MAX_CHARS characters, and the whole text to
SCHEMA_MAX_CHARS characters (dropping sample values first, then whole
tables, with a note saying so).
"""

import asyncio
import json
import logging
import re
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Protocol

from notebook_api.ai.extract import clip
from notebook_api.ai.pipeline import AssistantUnavailableError, SchemaContext
from notebook_api.query.engine import QueryResult
from notebook_api.query.runner import QueryFailedError
from notebook_api.query.serialize import JsonValue
from notebook_api.query.validate import QueryRejectedError

logger = logging.getLogger(__name__)

MAX_TABLES = 50
# A schema missing some tables' samples is read again after this long.
PARTIAL_RETRY_SECONDS = 60.0
SAMPLES_PER_COLUMN = 3
SAMPLE_MAX_CHARS = 40
COMMENT_MAX_CHARS = 200
# Roughly a few thousand tokens: enough for dozens of columns with samples,
# small next to the model's context window, and cheap to send every time.
SCHEMA_MAX_CHARS = 16_000
# Sample values come from the first rows of each table: cheap (no scan of
# a large table) and enough to show what values look like.
SAMPLE_ROWS = 200

_TABLES_SQL = """
SELECT table_name AS name, estimated_size AS row_estimate, comment
FROM duckdb_tables()
WHERE database_name = current_database() AND schema_name = 'main' AND NOT internal
UNION ALL
SELECT view_name, NULL, comment
FROM duckdb_views()
WHERE database_name = current_database() AND schema_name = 'main' AND NOT internal
ORDER BY name
"""
_COLUMNS_SQL = """
SELECT table_name, column_name, data_type, comment
FROM duckdb_columns()
WHERE database_name = current_database() AND schema_name = 'main' AND NOT internal
ORDER BY table_name, column_index
"""
_PLAIN_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_WHITESPACE = re.compile(r"\s+")


class Runner(Protocol):
    async def run(self, sql: str) -> QueryResult: ...


@dataclass
class ColumnInfo:
    name: str
    type: str
    comment: str | None
    samples: list[str] = field(default_factory=list)


@dataclass
class TableInfo:
    name: str
    row_estimate: int | None
    comment: str | None
    columns: list[ColumnInfo] = field(default_factory=list)


async def duckdb_schema_context(
    runner: Runner, *, row_limit: int, max_chars: int = SCHEMA_MAX_CHARS
) -> SchemaContext:
    """Read and render the notebook database's schema. Raises AssistantUnavailableError."""
    return (await read_schema_context(runner, row_limit=row_limit, max_chars=max_chars)).context


@dataclass(frozen=True)
class SchemaRead:
    context: SchemaContext
    # False if some table's sample values couldn't be read (the schema is
    # still usable, just without those samples).
    complete: bool


async def read_schema_context(
    runner: Runner, *, row_limit: int, max_chars: int = SCHEMA_MAX_CHARS
) -> SchemaRead:
    """The schema context, and whether every table's sample values were read.

    Raises AssistantUnavailableError if the tables and columns themselves
    can't be read.
    """
    try:
        tables, omitted = await _read_tables(runner)
    except (QueryFailedError, QueryRejectedError) as error:
        raise AssistantUnavailableError(
            "Couldn't read the database's schema for the AI assistant. Try again."
        ) from error
    complete = True
    for table in tables:
        if not await _read_samples(runner, table):
            complete = False
    notes = f"Notes: query results shown to people are capped at {row_limit} rows."
    text = render(tables, notes, max_chars, omitted=omitted)
    return SchemaRead(SchemaContext(dialect="duckdb", text=text), complete)


async def _read_tables(runner: Runner) -> tuple[list[TableInfo], int]:
    """The first MAX_TABLES tables with their columns, and how many more there are."""
    tables: dict[str, TableInfo] = {}
    omitted = 0
    for name, row_estimate, comment in (await runner.run(_TABLES_SQL))["rows"]:
        if len(tables) >= MAX_TABLES:
            omitted += 1
            continue
        tables[str(name)] = TableInfo(
            name=str(name),
            row_estimate=row_estimate if isinstance(row_estimate, int) else None,
            comment=_text(comment),
        )
    for table_name, column_name, data_type, comment in (await runner.run(_COLUMNS_SQL))["rows"]:
        table = tables.get(str(table_name))
        if table is not None:
            table.columns.append(ColumnInfo(str(column_name), str(data_type), _text(comment)))
    return list(tables.values()), omitted


async def _read_samples(runner: Runner, table: TableInfo) -> bool:
    """Fill in the table's sample values; False (and none) if they couldn't be read."""
    # The name comes from the database's own catalog and is quoted as an
    # identifier; the query still goes through the SELECT-only checks.
    sample_sql = f"SELECT * FROM {_quote(table.name)} LIMIT {SAMPLE_ROWS}"  # noqa: S608
    try:
        sample = await runner.run(sample_sql)
    except QueryFailedError, QueryRejectedError:
        # A busy engine, a timeout or an odd table: the schema is still
        # useful without this table's samples.
        logger.warning("could not read sample values for a table", exc_info=True)
        return False
    for index, column in enumerate(table.columns):
        column.samples = _samples(row[index] for row in sample["rows"] if index < len(row))
    return True


def _samples(values: Iterable[JsonValue]) -> list[str]:
    """The first few distinct non-null values, each as a short JSON literal."""
    seen: list[str] = []
    for value in values:
        if value is None:
            continue
        rendered = _literal(value)
        if rendered not in seen:
            seen.append(rendered)
            if len(seen) == SAMPLES_PER_COLUMN:
                break
    return seen


def _literal(value: JsonValue) -> str:
    if isinstance(value, str):
        return json.dumps(clip(value, SAMPLE_MAX_CHARS), ensure_ascii=False)
    return clip(json.dumps(value, ensure_ascii=False, separators=(",", ":")), SAMPLE_MAX_CHARS)


def render(tables: Sequence[TableInfo], notes: str, max_chars: int, omitted: int = 0) -> str:
    """The schema text, within max_chars: samples go first, then trailing tables.

    `omitted`: tables already left out (past MAX_TABLES); the text says how
    many tables in all aren't shown.
    """

    def with_note(dropped: int) -> str:
        if dropped == 0:
            return notes
        return f"{notes}\n({dropped} more tables are not shown.)"

    full = _render(tables, with_note(omitted), with_samples=True)
    if len(full) <= max_chars:
        return full
    without = _render(tables, with_note(omitted), with_samples=False)
    if len(without) <= max_chars:
        return without
    for keep in range(len(tables) - 1, -1, -1):
        dropped = len(tables) - keep + omitted
        text = _render(tables[:keep], with_note(dropped), with_samples=False)
        if len(text) <= max_chars:
            return text
    return clip(notes, max_chars)


def _render(tables: Sequence[TableInfo], notes: str, *, with_samples: bool) -> str:
    lines: list[str] = []
    for table in tables:
        header = f"Table {_display(table.name)}"
        if table.row_estimate is not None:
            header += f" (about {table.row_estimate} rows)"
        if table.comment:
            header += f": {json.dumps(table.comment, ensure_ascii=False)}"
        lines.append(header)
        for column in table.columns:
            line = f"  - {_display(column.name)} {column.type}"
            if column.comment:
                line += f"; comment: {json.dumps(column.comment, ensure_ascii=False)}"
            if with_samples and column.samples:
                line += f"; sample values: {', '.join(column.samples)}"
            lines.append(line)
        lines.append("")
    lines.append(notes)
    return "\n".join(lines)


def _text(value: JsonValue) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return clip(_WHITESPACE.sub(" ", value).strip(), COMMENT_MAX_CHARS)


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _display(name: str) -> str:
    return name if _PLAIN_NAME.match(name) else _quote(name)


class SchemaCache:
    """The schema context, built on first use and then kept (one per process).

    A schema missing some sample values (their query failed, say because the
    engine was busy) is used, but only kept for PARTIAL_RETRY_SECONDS, then
    read again, so a passing failure doesn't stay in every prompt for good.
    """

    def __init__(
        self, runner: Runner, row_limit: int, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._runner = runner
        self._row_limit = row_limit
        self._clock = clock
        self._schema: SchemaContext | None = None
        self._expires: float | None = None  # None: complete, kept for good
        self._lock = asyncio.Lock()

    def _fresh(self) -> bool:
        return self._schema is not None and (self._expires is None or self._clock() < self._expires)

    async def get(self) -> SchemaContext:
        if not self._fresh():
            async with self._lock:  # concurrent requests build it once
                if not self._fresh():
                    read = await read_schema_context(self._runner, row_limit=self._row_limit)
                    self._schema = read.context
                    self._expires = None if read.complete else self._clock() + PARTIAL_RETRY_SECONDS
        assert self._schema is not None  # noqa: S101 (set above or raised)
        return self._schema
