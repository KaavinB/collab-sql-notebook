"""Pulling the SQL and the explanation out of a model's reply.

The model is asked for exactly one ```sql fenced block plus a sentence or
two. Replies don't always comply, so extraction is forgiving about the
form and strict about the content:

- Several fenced blocks: the last block tagged `sql` (or a SQL dialect,
  such as `duckdb`) wins (a model that writes two usually corrects itself
  in the second). Without such a tag, the last untagged block that starts
  like a query is used.
- Prose before, between or after blocks becomes the explanation.
- No complete block (no fence at all, or a fence that was never closed
  because the reply was cut off): no SQL. A bare query with no fence is
  not guessed at either, because prose that happens to start with
  "Select" would then be sent to validation as SQL.

Whatever is extracted is only ever validated and shown as a suggestion; it
never runs on its own.
"""

import re
from dataclasses import dataclass

# A fence opens at the start of a line with three or more backticks and an
# optional language tag, and closes with a line of at least as many backticks.
_FENCE = re.compile(
    r"^(?P<fence>`{3,})[ \t]*(?P<lang>[A-Za-z0-9_+-]*)[^\n]*\n(?P<body>.*?)^(?P=fence)`*[ \t]*$",
    re.MULTILINE | re.DOTALL,
)
# Fence tags that mark a SQL block: models sometimes tag it with the dialect.
SQL_TAGS = frozenset({"sql", "duckdb", "sqlite", "postgresql", "postgres", "mysql"})
_QUERY_START = re.compile(r"^\s*(\(|select\b|with\b|from\b)", re.IGNORECASE)
_WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class Extracted:
    sql: str | None
    explanation: str  # whitespace-collapsed prose, possibly empty


def extract(text: str) -> Extracted:
    blocks = list(_FENCE.finditer(text))
    chosen: re.Match[str] | None = None
    for block in blocks:
        if block["lang"].lower() in SQL_TAGS:
            chosen = block
    if chosen is None:
        for block in blocks:
            if not block["lang"] and _QUERY_START.match(block["body"]):
                chosen = block

    sql: str | None = None
    if chosen is not None:
        sql = _clean_sql(chosen["body"])

    return Extracted(sql=sql or None, explanation=plain_text(text))


def plain_text(text: str) -> str:
    """The reply's prose as one paragraph, without any code blocks.

    Everything from a fence that is never closed onwards is dropped: it's
    the start of a block that was cut off, and half a query isn't prose.
    """
    prose = _FENCE.sub(" ", text)
    if "```" in prose:
        prose = prose[: prose.index("```")]
    return _WHITESPACE.sub(" ", prose).strip()


def _clean_sql(body: str) -> str:
    sql = body.strip()
    # A trailing semicolon is harmless but not part of the one statement.
    while sql.endswith(";"):
        sql = sql[:-1].rstrip()
    return sql


def clip(text: str, limit: int) -> str:
    """At most `limit` characters, cut at a word boundary with an ellipsis."""
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    space = cut.rfind(" ")
    if space > limit // 2:
        cut = cut[:space]
    return cut.rstrip() + "…"
