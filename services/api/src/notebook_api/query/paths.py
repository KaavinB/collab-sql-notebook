"""Keeping server file paths out of everything a person sees.

DuckDB mentions file paths in some error messages (the database file, the
spill directory when a sort or join spills), and a few of its functions
return them. The validator blocks the functions it knows about; this module
is the backstop: query errors and result values are passed through
`PathScrubber` before they leave the worker, and the AI validator and the
eval clean their messages with it too, so every route uses the same list.

Only the specific private paths are replaced: the database file (which also
covers its .wal files, whose names start with it) and the spill root (which
covers every worker's spill directory inside it), each as given and fully
resolved. Not their parent directories, and nothing shorter than
MIN_PATH_CHARS: a short or generic path like /data would also match ordinary
values (https://example.com/data/x) and rewrite people's own data.

Known limit: replacing a path is itself a signal. Someone who guesses the
exact database path and writes it into a query sees `<server path>` come
back where they typed it, which confirms the guess. That needs the exact
path already; the scrubber doesn't try to hide that it ran.
"""

from collections.abc import Iterable
from pathlib import Path

from notebook_api.query.serialize import JsonValue

PLACEHOLDER = "<server path>"
# Shorter paths are too likely to occur in ordinary values to replace safely.
MIN_PATH_CHARS = 8


def private_paths(db_path: Path, spill_root: Path) -> list[Path]:
    """The server paths that must not reach users: the database file (and so
    its .wal files) and the spill root (and so every worker's spill directory)."""
    return [db_path, spill_root]


class PathScrubber:
    """Replaces any of the given paths inside text with a placeholder."""

    def __init__(self, paths: Iterable[Path]) -> None:
        names: set[str] = set()
        for path in paths:
            # Both spellings: DuckDB reports a path as it was given to it in
            # some places and fully resolved in others (on macOS, /var/... is
            # a symlink to /private/var/..., and both forms show up).
            names.add(str(path))
            try:
                names.add(str(path.resolve()))
            except OSError, RuntimeError:  # a symlink loop: the given form is all we have
                pass
        # Longest first, so a path is replaced before any prefix of it is.
        self._names = sorted(
            (name for name in names if len(name) >= MIN_PATH_CHARS), key=len, reverse=True
        )

    def text(self, text: str) -> str:
        for name in self._names:
            if name in text:
                text = text.replace(name, PLACEHOLDER)
        return text

    def value(self, value: JsonValue) -> JsonValue:
        """A JSON-safe result value with every string inside it cleaned."""
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self.value(item) for item in value]
        if isinstance(value, dict):
            return {self.text(key): self.value(item) for key, item in value.items()}
        return value
