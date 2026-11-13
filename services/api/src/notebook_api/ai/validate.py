"""Checking SQL the model wrote against the notebook's DuckDB database, without running it.

Two steps, both the ones a person's query goes through before it runs:
1. `prepare_query` (sqlglot): exactly one SELECT, nothing forbidden.
2. EXPLAIN on a query worker: DuckDB binds and plans it, which catches
   unknown tables and columns, type errors and bad function calls. Same
   worker pool, lockdown, timeout and kill-on-overrun as running a cell.

The error that comes back is fed to the model for a repair and stored in
the request log, so it's kept short and stripped of server paths (DuckDB
can mention the database file or the spill directory in its messages).
"""

from collections.abc import Iterable
from pathlib import Path
from typing import Protocol

from notebook_api.ai.extract import clip
from notebook_api.ai.pipeline import AssistantUnavailableError
from notebook_api.query.runner import QueryFailedError
from notebook_api.query.validate import MAX_SQL_CHARS, QueryRejectedError

# Long enough for DuckDB's message and its "Candidate bindings" hint.
ERROR_MAX_CHARS = 500
_ENGINE_BUSY = "The query engine is busy, so the AI's answer couldn't be checked. Try again."


class Explainer(Protocol):
    """What validation needs from the query runner (QueryRunner in production)."""

    async def explain(self, sql: str) -> None: ...


class DuckDbValidator:
    """The pipeline's Validator for the notebook database."""

    def __init__(self, runner: Explainer, private_paths: Iterable[Path] = ()) -> None:
        """`private_paths`: server paths to remove from errors (database file, spill dir)."""
        self._runner = runner
        # Longest first, so a path is replaced before any prefix of it is.
        names = {str(path) for path in private_paths if str(path) not in ("", ".", "/")}
        self._private = sorted(names, key=len, reverse=True)

    async def validate(self, sql: str) -> str | None:
        if len(sql) > MAX_SQL_CHARS:
            return f"The query is longer than {MAX_SQL_CHARS} characters."
        try:
            await self._runner.explain(sql)
        except QueryRejectedError as rejected:
            return self._clean(str(rejected))
        except QueryFailedError as failed:
            if failed.kind in ("busy", "crashed"):
                # The engine couldn't answer; that says nothing about the SQL.
                raise AssistantUnavailableError(_ENGINE_BUSY) from None
            return self._clean(str(failed))
        return None

    def _clean(self, message: str) -> str:
        # DuckDB follows its message with a blank line and an excerpt of the
        # statement ("LINE 1: EXPLAIN SELECT ...") pointing at the problem.
        # That excerpt quotes the regenerated EXPLAIN statement rather than
        # the model's own text, so it would confuse more than help.
        message = message.split("\n\n", 1)[0].strip()
        for path in self._private:
            message = message.replace(path, "<server path>")
        return clip(message, ERROR_MAX_CHARS)
