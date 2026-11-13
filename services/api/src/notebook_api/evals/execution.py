"""What running one query produced, in a form scoring can compare."""

from collections.abc import Hashable
from dataclasses import dataclass
from typing import Literal

ExecStatus = Literal["ok", "error", "timeout", "too_many_rows"]

# Error text kept per question in the results file. Database errors can be
# long (they may quote the whole query); the first line is what's useful.
MAX_ERROR_CHARS = 300


@dataclass(frozen=True)
class ExecOutcome:
    status: ExecStatus
    # The result as a set of rows (None unless status is "ok"). A set, because
    # BIRD's execution accuracy ignores row order and duplicate rows.
    rows: frozenset[tuple[Hashable, ...]] | None = None
    row_count: int = 0  # rows fetched (before de-duplication)
    error: str | None = None
    duration_ms: float = 0.0

    def to_json(self) -> dict[str, object]:
        """What the results file keeps: never the rows themselves (they can be large)."""
        return {
            "status": self.status,
            "row_count": self.row_count,
            "error": self.error,
            "duration_ms": self.duration_ms,
        }


def short_error(error: BaseException | str) -> str:
    text = str(error).strip()
    if not text:
        text = type(error).__name__ if isinstance(error, BaseException) else "unknown error"
    first = text.splitlines()[0]
    if len(first) > MAX_ERROR_CHARS:
        return first[: MAX_ERROR_CHARS - 1] + "…"
    return first
