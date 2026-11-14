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
from notebook_api.query.paths import PathScrubber, private_paths
from notebook_api.query.runner import QueryFailedError
from notebook_api.query.validate import MAX_SQL_CHARS, QueryRejectedError

# Long enough for DuckDB's message and its "Candidate bindings" hint.
ERROR_MAX_CHARS = 500
_ENGINE_BUSY = "The query engine is busy, so the AI's answer couldn't be checked. Try again."


class Explainer(Protocol):
    """What validation needs from the query runner (QueryRunner in production)."""

    async def explain(self, sql: str) -> None: ...


def notebook_private_paths(db_path: Path, spill_root: Path) -> list[Path]:
    """Server paths removed from validation errors before they're logged or sent to the model.

    The database file and the spill directory: the same list
    the query workers clean their own errors and results with. Shared by the
    notebook's assistant and the eval, so both see exactly the same errors.
    """
    return private_paths(db_path, spill_root)


class DuckDbValidator:
    """The pipeline's Validator for the notebook database."""

    def __init__(self, runner: Explainer, private_paths: Iterable[Path] = ()) -> None:
        """`private_paths`: server paths to remove from errors (database file, spill dir)."""
        self._runner = runner
        self._scrubber = PathScrubber(private_paths)

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
        return clip(self._scrubber.text(message), ERROR_MAX_CHARS)
