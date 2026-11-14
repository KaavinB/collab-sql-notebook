"""Static checks on user SQL before it reaches DuckDB (before engine-level isolation).

The parser is not the security boundary on its own: a SELECT can still call
DuckDB table functions. The engine lockdown in `engine.py` (read-only file,
external access off, settings locked) is what makes those calls fail. This
layer gives clear errors early, rejects anything that isn't a single query,
and applies the row cap through the syntax tree.

What runs is the SQL that sqlglot generates from the checked tree, never the
original text, so the statement that was validated is exactly the one that
executes. (If we validated one string and executed another, a parser
disagreement could smuggle something through.)

One disagreement remains possible even so: how DuckDB reads the regenerated
text. sqlglot keeps a zero-width space inside a name and writes it back out
unquoted, while DuckDB reads it as whitespace, so `query<U+200B>('...')`
looked like an unknown function here but ran DuckDB's query(). So no
invisible formatting or control character may appear anywhere but inside a
string literal.
"""

import unicodedata
from dataclasses import dataclass

import sqlglot
from sqlglot import exp
from sqlglot.errors import SqlglotError

# Statement nodes that must not appear anywhere in the tree, e.g. an INSERT
# hidden inside a CTE, which sqlglot parses as a SELECT at the top level.
_FORBIDDEN_NODES: tuple[type[exp.Expression], ...] = (
    exp.Insert,
    exp.Update,
    exp.Delete,
    exp.Merge,
    exp.Create,
    exp.Drop,
    exp.Alter,
    exp.Copy,
    exp.Pragma,
    exp.Set,
    exp.Attach,
    exp.Detach,
    exp.Use,
    exp.Transaction,
    exp.Commit,
    exp.Rollback,
    # Anything sqlglot couldn't parse (EXPLAIN, CALL, LOAD, ...).
    exp.Command,
)

# Functions that run SQL passed in as a string, or read a table whose name
# is a string. They would bypass every check in this module, so they're
# rejected by name. histogram_values is one of DuckDB's built-in table
# macros, and its body calls query_table() on its first argument, so
# `histogram_values('pg_settings', setting)` would read a blocked view.
# (File and network readers are not listed: the engine lockdown blocks them,
# and a denylist of them would always be incomplete. Even if a new
# SQL-running function slipped through, each query gets a fresh cursor, so it
# couldn't leave state behind. tests/test_query_validate.py checks every
# built-in macro and table function against these lists, so a DuckDB upgrade
# that adds one fails a test until someone reviews it.)
_FORBIDDEN_FUNCTIONS = frozenset(
    {"query", "query_table", "json_execute_serialized_sql", "histogram_values"}
)
# Names that are an ordinary aggregate in an expression but a table macro in
# FROM: `histogram(col)` counts values, while `FROM histogram('t', col)` calls
# histogram_values() (and so query_table()). Rejected only in FROM.
_FORBIDDEN_IN_FROM = frozenset({"histogram"})
# Where sqlglot puts a function called in FROM: `FROM f(...)`, `JOIN f(...)`
# and `, f(...)` give a Table around it; `LATERAL f(...)` a Lateral.
_FROM_ITEMS: tuple[type[exp.Expression], ...] = (exp.Table, exp.Lateral, exp.From, exp.Join)

# Functions that describe the server rather than the data: its settings
# (which include the database file's path and the spill directory), the
# attached databases and their paths, temporary files, extensions, secrets,
# environment variables and DuckDB's log (shared by every query a worker
# runs, so it could show one person's queries to another). None of them is
# needed to analyse the dataset. The worker also removes server paths from
# results and errors, as a backstop for anything not listed here.
_SERVER_INFO_FUNCTIONS = frozenset(
    {
        "current_setting",
        "duckdb_settings",
        "duckdb_databases",
        "duckdb_temporary_files",
        "duckdb_extensions",
        "duckdb_extension_repositories",
        "duckdb_external_file_cache",
        "duckdb_secrets",
        "which_secret",
        "duckdb_logs",
        "duckdb_logs_parsed",
        "duckdb_log_contexts",
        # A built-in table macro that reads duckdb_settings().
        "duckdb_profiling_settings",
        "getenv",
        # The worker's runtime state and the build it runs: memory use,
        # connections, attached-database count, registered resources, loaded
        # grammar extensions, storage metadata, platform and build. (The
        # DuckDB version itself isn't secret: the scalar version() returns it.)
        "duckdb_memory",
        "duckdb_eviction_queues",
        "duckdb_connection_count",
        "duckdb_approx_database_count",
        "duckdb_external_resources",
        "duckdb_grammar_extensions",
        "pragma_metadata_info",
        "pragma_database_size",
        # A built-in macro that reads pragma_database_size().
        "get_block_size",
        "pragma_platform",
        "pragma_user_agent",
    }
)
# DuckDB's built-in views over those functions, used as plain table names
# (`FROM pragma_database_list`, `FROM pg_catalog.pg_settings`).
_SERVER_INFO_TABLES = frozenset(
    {"duckdb_databases", "pragma_database_list", "pg_settings", "duckdb_logs"}
)
# Table functions that change the engine's state or are internal plumbing.
# A read-only query never needs them. Most already fail (the configuration
# is locked, the database is read-only, or they need a Python pointer), but
# some don't (truncate_duckdb_logs clears the worker's shared log), and
# blocking by name doesn't depend on each one's own checks.
_ENGINE_CONTROL_FUNCTIONS = frozenset(
    {
        "checkpoint",
        "force_checkpoint",
        "enable_logging",
        "disable_logging",
        "truncate_duckdb_logs",
        "enable_profiling",
        "disable_profiling",
        "create_external_resource",
        "destroy_external_resource",
        "register_external_resource",
        "deregister_external_resource",
        "register_external_resource_type",
        # Scans of Python and Arrow objects, which the Python client calls
        # with raw pointers, and the planner's internal table scan.
        "arrow_scan",
        "arrow_scan_dumb",
        "python_arrow_scan",
        "pandas_scan",
        "python_map_function",
        "seq_scan",
    }
)


# Generous for hand-written or AI-written queries, and keeps parsing cheap:
# sqlglot is pure Python, so parse time grows with the query's length.
MAX_SQL_CHARS = 20_000


class QueryRejectedError(Exception):
    """The SQL is not a single read-only query. The message is safe to show users."""


@dataclass(frozen=True)
class PreparedQuery:
    sql: str
    """The SQL to execute, regenerated from the validated syntax tree. It
    returns at most row_limit + 1 rows, so the caller can tell whether the
    result was truncated."""


def prepare_query(sql: str, row_limit: int) -> PreparedQuery:
    """Validate `sql` and cap how many rows it can return.

    Raises QueryRejectedError if it isn't exactly one SELECT-style query.
    This is CPU-bound (pure-Python parsing); async callers should run it off
    the event loop.
    """
    if row_limit < 1:
        raise ValueError("row_limit must be at least 1")
    # The routes cap the length too; checked here as well so every caller
    # (AI validation, schema reads, the eval) gets the same bound on parse time.
    if len(sql) > MAX_SQL_CHARS:
        raise QueryRejectedError(f"The query is longer than {MAX_SQL_CHARS} characters.")
    try:
        statements = [s for s in sqlglot.parse(sql, read="duckdb") if s is not None]
    except SqlglotError as error:  # ParseError, TokenError (e.g. an unclosed quote)
        raise QueryRejectedError(f"Could not parse the query: {_first_line(error)}") from None
    except RecursionError:  # absurdly deep nesting
        raise QueryRejectedError("The query is nested too deeply to parse.") from None

    if not statements:
        raise QueryRejectedError("The query is empty.")
    if len(statements) > 1:
        raise QueryRejectedError("Run one statement at a time.")
    tree = statements[0]

    # Allowed at the top level: plain SELECT (including DuckDB's FROM-first form
    # and CTEs) and UNION / INTERSECT / EXCEPT.
    if not isinstance(tree, (exp.Select, exp.SetOperation)):
        raise QueryRejectedError("Only SELECT queries are allowed.")
    for node in tree.walk():
        if not (isinstance(node, exp.Literal) and node.is_string):
            hidden = _hidden_character(node)
            if hidden is not None:
                raise QueryRejectedError(
                    f"The query contains an invisible character (U+{ord(hidden):04X}) outside "
                    "a string. Remove it and try again."
                )
        if isinstance(node, _FORBIDDEN_NODES):
            raise QueryRejectedError("Only SELECT queries are allowed.")
        if isinstance(node, exp.Func):
            name = _function_name(node)
            if name in _FORBIDDEN_FUNCTIONS:
                raise QueryRejectedError(f"The function {name}() is not allowed.")
            if name in _ENGINE_CONTROL_FUNCTIONS:
                raise QueryRejectedError(
                    f"The function {name}() is not allowed: it controls the query engine, "
                    "not the data."
                )
            if name in _FORBIDDEN_IN_FROM and isinstance(node.parent, _FROM_ITEMS):
                raise QueryRejectedError(
                    f"{name}() is not allowed as a table function (it reads a table named "
                    f"by a string). The {name}(column) aggregate works."
                )
            if name in _SERVER_INFO_FUNCTIONS:
                raise QueryRejectedError(
                    f"The function {name}() is not available: it describes the server, "
                    "not the data."
                )
        # Names compare case-insensitively, as DuckDB resolves them, quoted or not.
        if isinstance(node, exp.Table) and node.name.lower() in _SERVER_INFO_TABLES:
            raise QueryRejectedError(
                f"{node.name} is not available: it describes the server, not the data."
            )

    capped = _cap_rows(tree, row_limit + 1)
    try:
        # comments=False: comments are dropped from the SQL that runs, so
        # nothing inside a comment can ever be re-read as SQL.
        return PreparedQuery(sql=capped.sql(dialect="duckdb", comments=False))
    except RecursionError:
        raise QueryRejectedError("The query is nested too deeply to parse.") from None


def _cap_rows(tree: exp.Query, fetch_limit: int) -> exp.Query:
    """Make the query return at most `fetch_limit` rows through the syntax tree.

    Rewriting the query's own LIMIT lets DuckDB stop early and keeps the
    user's ORDER BY and OFFSET as written. A LIMIT that isn't a plain integer
    (a percentage, an expression, a subquery) can't be compared, so the query
    is wrapped instead: SELECT * FROM (<query>) LIMIT n.
    """
    limit = tree.args.get("limit")
    if limit is None:
        return tree.limit(fetch_limit, copy=True)
    if isinstance(limit, exp.Limit) and _is_plain_int_limit(limit):
        if int(limit.expression.name) <= fetch_limit:
            return tree
        return tree.limit(fetch_limit, copy=True)
    return exp.select("*").from_(tree.subquery("capped_query", copy=True)).limit(fetch_limit)


def _is_plain_int_limit(limit: exp.Limit) -> bool:
    options = limit.args.get("limit_options")
    if options is not None and (options.args.get("percent") or options.args.get("with_ties")):
        return False
    value = limit.expression
    return isinstance(value, exp.Literal) and value.is_int


def _hidden_character(node: exp.Expr) -> str | None:
    """The first format or control character in the node's own text (a name,
    a number, a keyword), or None. Format characters (category Cf) include
    zero-width spaces, joiners, byte-order marks and bidirectional controls.
    Tabs and line breaks are ordinary whitespace to both parsers."""
    for value in node.args.values():
        if isinstance(value, str):
            for char in value:
                category = unicodedata.category(char)
                if category == "Cf" or (category == "Cc" and char not in "\t\n\r"):
                    return char
    return None


def _function_name(func: exp.Func) -> str:
    # Unknown functions are Anonymous and carry their name; known ones (e.g.
    # ReadCSV) report their SQL name.
    if isinstance(func, exp.Anonymous):
        return func.name.lower()
    return func.sql_name().lower()


def _first_line(error: Exception) -> str:
    return str(error).strip().splitlines()[0]
