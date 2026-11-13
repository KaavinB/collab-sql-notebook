"""BIRD's SQLite databases: read-only connections, schema context, validation, execution.

Every connection is opened with the URI `mode=ro`, so SQLite itself refuses
writes whatever the SQL says. On top of that, connections that run model or
gold SQL get an authorizer that allows only reading (SELECT, reading
columns, calling functions, recursive CTEs) and refuses everything else
(ATTACH, PRAGMA, writes, ...), and attaching other files is limited to zero.
Model-written SQL is untrusted input; these layers keep it from touching
anything but the one benchmark database.
"""

import asyncio
import sqlite3
import time
from collections.abc import Hashable, Iterable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import sqlglot
from sqlglot import exp
from sqlglot.errors import SqlglotError

from notebook_api.ai.pipeline import SchemaContext
from notebook_api.evals.execution import ExecOutcome, short_error

# The same cap the notebook applies to SQL people or the assistant write.
MAX_SQL_CHARS = 20_000

# Schema context bounds. A prompt carries the whole schema, so its size is
# capped: sample values are what grow it, so they go first if it's too big.
SAMPLES_PER_COLUMN = 3
SAMPLE_SCAN_ROWS = 1_000  # sample values come from the first rows only, so it stays fast
SAMPLE_MAX_CHARS = 40  # longer strings are cut, with an ellipsis
MAX_SCHEMA_CHARS = 60_000
_SCHEMA_QUERY_TIMEOUT_SECONDS = 2.0

# How often (in SQLite virtual machine instructions) the timeout is checked.
_PROGRESS_INTERVAL = 1_000

_ALLOWED_ACTIONS = frozenset(
    {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, sqlite3.SQLITE_RECURSIVE}
)
_FORBIDDEN_FUNCTIONS = frozenset({"load_extension"})

# Statement nodes that may not appear anywhere in a query (e.g. a write
# hidden in a CTE). The read-only connection would refuse them anyway; this
# turns them into a clear validation error.
_FORBIDDEN_NODES: tuple[type[exp.Expression], ...] = (
    exp.Insert,
    exp.Update,
    exp.Delete,
    exp.Merge,
    exp.Create,
    exp.Drop,
    exp.Alter,
    exp.Pragma,
    exp.Attach,
    exp.Detach,
    exp.Transaction,
    exp.Commit,
    exp.Rollback,
    exp.Command,
)


def _authorize(action: int, arg1: str | None, arg2: str | None, *_: str | None) -> int:
    if action not in _ALLOWED_ACTIONS:
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_FUNCTION and (arg2 or "").lower() in _FORBIDDEN_FUNCTIONS:
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def _decode_text(raw: bytes) -> str:
    # A few BIRD values aren't valid UTF-8. Replacing the bad bytes (the same
    # way for gold and predicted results) beats failing the whole query.
    return raw.decode("utf-8", errors="replace")


def open_read_only(db_path: Path, *, restricted: bool = True) -> sqlite3.Connection:
    """A read-only connection; `restricted` adds the read-only authorizer."""
    if not db_path.is_file():
        raise FileNotFoundError(f"database not found: {db_path}")
    uri = f"file:{quote(str(db_path.resolve()))}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.text_factory = _decode_text
    con.setlimit(sqlite3.SQLITE_LIMIT_ATTACHED, 0)
    con.execute("PRAGMA query_only = ON")
    if restricted:
        con.set_authorizer(_authorize)
    return con


class _Deadline:
    def __init__(self, con: sqlite3.Connection, seconds: float) -> None:
        self._deadline = time.monotonic() + seconds
        self.expired = False
        con.set_progress_handler(self._check, _PROGRESS_INTERVAL)

    def _check(self) -> int:
        if time.monotonic() > self._deadline:
            self.expired = True
            return 1  # non-zero aborts the statement ("interrupted")
        return 0


def execute_query(db_path: Path, sql: str, *, timeout_seconds: float, row_cap: int) -> ExecOutcome:
    """Run `sql` on a fresh restricted read-only connection.

    Blocking; async callers use asyncio.to_thread. Errors, timeouts and
    results larger than `row_cap` rows come back as outcomes, never raise.
    """
    started = time.perf_counter()

    def elapsed() -> float:
        return round((time.perf_counter() - started) * 1000, 3)

    if len(sql) > MAX_SQL_CHARS:
        return ExecOutcome("error", error="query is longer than the allowed length")
    try:
        con = open_read_only(db_path)
    except (sqlite3.Error, OSError) as error:
        return ExecOutcome("error", error=short_error(error), duration_ms=elapsed())
    deadline = _Deadline(con, timeout_seconds)
    rows: set[tuple[Hashable, ...]] = set()
    count = 0
    try:
        cursor = con.execute(sql)
        while batch := cursor.fetchmany(500):
            count += len(batch)
            if count > row_cap:
                return ExecOutcome(
                    "too_many_rows",
                    row_count=count,
                    error=f"more than {row_cap} rows",
                    duration_ms=elapsed(),
                )
            rows.update(tuple(row) for row in batch)
    except sqlite3.Error as error:
        if deadline.expired:
            return ExecOutcome(
                "timeout",
                error=f"stopped after {timeout_seconds:g} seconds",
                duration_ms=elapsed(),
            )
        return ExecOutcome("error", error=short_error(error), duration_ms=elapsed())
    except (ValueError, OverflowError, MemoryError) as error:
        return ExecOutcome("error", error=short_error(error), duration_ms=elapsed())
    finally:
        con.close()
    return ExecOutcome("ok", rows=frozenset(rows), row_count=count, duration_ms=elapsed())


def check_select(sql: str, dialect: str) -> str | None:
    """None if `sql` is exactly one SELECT-style statement; else a short reason."""
    if not sql.strip():
        return "The query is empty."
    if len(sql) > MAX_SQL_CHARS:
        return f"The query is longer than {MAX_SQL_CHARS} characters."
    try:
        statements = [s for s in sqlglot.parse(sql, read=dialect) if s is not None]
    except SqlglotError as error:
        return f"Could not parse the query: {short_error(error)}"
    except RecursionError:
        return "The query is nested too deeply to parse."
    if not statements:
        return "The query is empty."
    if len(statements) > 1:
        return "Write exactly one statement."
    tree = statements[0]
    if not isinstance(tree, (exp.Select, exp.SetOperation)):
        return "Only SELECT queries are allowed."
    if any(isinstance(node, _FORBIDDEN_NODES) for node in tree.walk()):
        return "Only SELECT queries are allowed."
    return None


class SqliteValidator:
    """The pipeline's validator for a BIRD database: parse, then EXPLAIN.

    EXPLAIN compiles the statement against the real schema (catching unknown
    tables, columns and functions) without running it.
    """

    def __init__(self, db_path: Path, *, timeout_seconds: float = 5.0) -> None:
        self._db_path = db_path
        self._timeout_seconds = timeout_seconds

    async def validate(self, sql: str) -> str | None:
        return await asyncio.to_thread(self.validate_sync, sql)

    def validate_sync(self, sql: str) -> str | None:
        reason = check_select(sql, "sqlite")
        if reason is not None:
            return reason
        con = open_read_only(self._db_path)
        deadline = _Deadline(con, self._timeout_seconds)
        try:
            con.execute(f"EXPLAIN {sql}").fetchall()
        except sqlite3.Error as error:
            if deadline.expired:
                return "Planning the query took too long."
            return short_error(error)
        except (ValueError, OverflowError) as error:
            return short_error(error)
        finally:
            con.close()
        return None


@dataclass(frozen=True)
class _Column:
    name: str
    type: str
    primary_key: int  # position in the primary key (1, 2, ...), 0 if not part of it
    samples: list[str]


def sqlite_schema_context(db_path: Path, *, max_chars: int = MAX_SCHEMA_CHARS) -> SchemaContext:
    """Tables, columns, types, keys and a few sample values, as CREATE TABLE text.

    Blocking. If the text with samples is over `max_chars`, it's rendered with
    fewer samples, then none, and only then cut (with a note saying so).
    """
    con = open_read_only(db_path, restricted=False)
    try:
        tables = _read_tables(con)
    finally:
        con.close()
    for samples in (SAMPLES_PER_COLUMN, 1, 0):
        text = _render(tables, samples)
        if len(text) <= max_chars:
            return SchemaContext(dialect="sqlite", text=text)
    note = "\n-- (schema cut here: too long to include in full)\n"
    return SchemaContext(dialect="sqlite", text=text[: max_chars - len(note)] + note)


# A foreign key: (columns, referenced table, referenced columns; empty = its primary key).
_ForeignKey = tuple[list[str], str, list[str]]
_Table = tuple[str, list[_Column], list[_ForeignKey]]


def _read_tables(con: sqlite3.Connection) -> list[_Table]:
    names = [
        row[0]
        for row in con.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' "
            "AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
        )
    ]
    tables: list[_Table] = []
    for name in names:
        columns = [
            _Column(
                name=str(row[1]),
                type=str(row[2] or ""),
                primary_key=int(row[5] or 0),
                samples=_samples(con, name, str(row[1])),
            )
            for row in con.execute("SELECT * FROM pragma_table_info(?)", (name,))
        ]
        # One row per column of each key; rows of a multi-column key share an id.
        foreign_keys: dict[int, _ForeignKey] = {}
        for row in con.execute(
            'SELECT id, seq, "table", "from", "to" FROM pragma_foreign_key_list(?) '
            "ORDER BY id, seq",
            (name,),
        ):
            key = foreign_keys.setdefault(int(row[0]), ([], str(row[2]), []))
            key[0].append(str(row[3]))
            if row[4] is not None:
                key[2].append(str(row[4]))
        tables.append((name, columns, list(foreign_keys.values())))
    return tables


def _samples(con: sqlite3.Connection, table: str, column: str) -> list[str]:
    # Identifiers can't be bound as parameters; they're quoted (and their
    # quotes escaped) by quote_ident, and come from the database's own schema.
    col, tbl = quote_ident(column), quote_ident(table)
    sql = (
        f"SELECT DISTINCT v FROM (SELECT {col} AS v FROM {tbl} "  # noqa: S608
        f"WHERE {col} IS NOT NULL LIMIT {SAMPLE_SCAN_ROWS}) LIMIT {SAMPLES_PER_COLUMN}"
    )
    _Deadline(con, _SCHEMA_QUERY_TIMEOUT_SECONDS)
    try:
        values = [row[0] for row in con.execute(sql)]
    except sqlite3.Error:
        return []  # a sample is a hint; a column we can't sample just has none
    finally:
        con.set_progress_handler(None, 0)
    return [rendered for value in values if (rendered := render_value(value)) is not None]


def render_value(value: object) -> str | None:
    """A sample value as a SQL literal on one line; None for blobs."""
    if isinstance(value, bytes):
        return None
    if isinstance(value, (int, float)):
        return repr(value)
    text = " ".join(str(value).split())  # newlines and tabs can't break the comment
    if len(text) > SAMPLE_MAX_CHARS:
        text = text[: SAMPLE_MAX_CHARS - 1] + "…"
    return "'" + text.replace("'", "''") + "'"


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _render(tables: list[_Table], samples: int) -> str:
    """Valid SQLite DDL: sample values sit in `--` comments after each line's comma."""
    blocks: list[str] = []
    for name, columns, foreign_keys in tables:
        # (definition, comment) pairs; the comma goes between them.
        entries: list[tuple[str, str]] = []
        key_columns = sorted((c for c in columns if c.primary_key), key=lambda c: c.primary_key)
        for column in columns:
            definition = f"{quote_ident(column.name)} {column.type}".rstrip()
            if column.primary_key and len(key_columns) == 1:
                definition += " PRIMARY KEY"
            comment = ""
            if samples and column.samples:
                comment = f" -- e.g. {', '.join(column.samples[:samples])}"
            entries.append((definition, comment))
        if len(key_columns) > 1:
            entries.append((f"PRIMARY KEY ({_ident_list(c.name for c in key_columns)})", ""))
        for from_cols, ref_table, ref_cols in foreign_keys:
            target = f" ({_ident_list(ref_cols)})" if ref_cols else ""
            entries.append(
                (
                    f"FOREIGN KEY ({_ident_list(from_cols)}) "
                    f"REFERENCES {quote_ident(ref_table)}{target}",
                    "",
                )
            )
        lines = [
            f"  {definition}{',' if index < len(entries) - 1 else ''}{comment}"
            for index, (definition, comment) in enumerate(entries)
        ]
        blocks.append(f"CREATE TABLE {quote_ident(name)} (\n" + "\n".join(lines) + "\n);")
    return "\n\n".join(blocks) + "\n"


def _ident_list(names: Iterable[str]) -> str:
    return ", ".join(quote_ident(name) for name in names)
