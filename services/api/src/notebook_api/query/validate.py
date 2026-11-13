"""Static checks on user SQL before it reaches DuckDB (layer 1 of D4).

The parser is not the security boundary on its own: a SELECT can still call
DuckDB table functions. The engine lockdown in `engine.py` (read-only file,
external access off, settings locked) is what makes those calls fail. This
layer gives clear errors early, rejects anything that isn't a single query,
and applies the row cap (D5).

What runs is the SQL that sqlglot generates from the checked tree, never the
original text, so the statement that was validated is exactly the one that
executes. (If we validated one string and executed another, a parser
disagreement could smuggle something through.)
"""

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

# Functions that run SQL passed in as a string. They would bypass every check
# in this module, so they're rejected by name. (File and network readers are
# not listed: the engine lockdown blocks them, and a denylist of them would
# always be incomplete. Even if a new SQL-running function slipped through,
# each query gets a fresh cursor, so it couldn't leave state behind.)
_FORBIDDEN_FUNCTIONS = frozenset({"query", "query_table", "json_execute_serialized_sql"})


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
        if isinstance(node, _FORBIDDEN_NODES):
            raise QueryRejectedError("Only SELECT queries are allowed.")
        if isinstance(node, exp.Func) and _function_name(node) in _FORBIDDEN_FUNCTIONS:
            raise QueryRejectedError(f"The function {_function_name(node)}() is not allowed.")

    capped = _cap_rows(tree, row_limit + 1)
    try:
        # comments=False: comments are dropped from the SQL that runs, so
        # nothing inside a comment can ever be re-read as SQL.
        return PreparedQuery(sql=capped.sql(dialect="duckdb", comments=False))
    except RecursionError:
        raise QueryRejectedError("The query is nested too deeply to parse.") from None


def _cap_rows(tree: exp.Query, fetch_limit: int) -> exp.Query:
    """Make the query return at most `fetch_limit` rows (D5).

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


def _function_name(func: exp.Func) -> str:
    # Unknown functions are Anonymous and carry their name; known ones (e.g.
    # ReadCSV) report their SQL name.
    if isinstance(func, exp.Anonymous):
        return func.name.lower()
    return func.sql_name().lower()


def _first_line(error: Exception) -> str:
    return str(error).strip().splitlines()[0]
