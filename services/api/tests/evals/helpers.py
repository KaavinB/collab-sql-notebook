"""Tiny stand-ins for BIRD and the model, so eval tests need no network and no API."""

import asyncio
import hashlib
import io
import json
import sqlite3
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import duckdb

from notebook_api.ai.pipeline import (
    Attempt,
    GenerationResult,
    ModelClient,
    ModelReply,
    SchemaContext,
    Validator,
)
from notebook_api.evals.bird import Archive

FOLDER = "dev_test"

# A gold query that never finishes on its own (stopped by the timeout).
ENDLESS_SQL = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT max(i) FROM n"


def write_shop_db(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, city TEXT);
        CREATE TABLE orders (
            id INTEGER PRIMARY KEY,
            customer_id INTEGER REFERENCES customers (id),
            amount REAL
        );
        INSERT INTO customers VALUES (1, 'Ada', 'London'), (2, 'Grace', 'New York'),
            (3, 'Linus', 'Helsinki');
        INSERT INTO orders VALUES (1, 1, 10.0), (2, 1, 5.0), (3, 2, 7.5), (4, 3, 7.5);
        """
    )
    con.commit()
    con.close()
    return path


# question_id -> (question, gold SQL, difficulty)
QUESTIONS: dict[int, tuple[str, str, str]] = {
    1: (
        "Names of customers in London?",
        "SELECT name FROM customers WHERE city = 'London'",
        "simple",
    ),
    2: ("All cities?", "SELECT city FROM customers ORDER BY city", "simple"),
    3: ("Distinct order amounts?", "SELECT amount FROM orders", "moderate"),
    4: ("Total spent by Ada?", "SELECT sum(amount) FROM orders WHERE customer_id = 1", "moderate"),
    5: ("A question with broken gold SQL", "SELECT nope FROM customers", "challenging"),
    6: ("A question whose gold SQL never ends", ENDLESS_SQL, "challenging"),
}


def dev_json_items() -> list[dict[str, object]]:
    return [
        {
            "question_id": qid,
            "db_id": "shop",
            "question": question,
            "evidence": f"hint {qid}",
            "SQL": gold,
            "difficulty": difficulty,
        }
        for qid, (question, gold, difficulty) in QUESTIONS.items()
    ]


def build_dev_zip(tmp: Path, *, extra_inner: dict[str, bytes] | None = None) -> bytes:
    """A zip shaped like BIRD's dev.zip: dev.json plus a nested dev_databases.zip."""
    db = write_shop_db(tmp / "build" / "shop.sqlite")
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("dev_databases/", b"")
        z.write(db, "dev_databases/shop/shop.sqlite")
        z.writestr("dev_databases/shop/.DS_Store", b"junk")
        z.writestr("__MACOSX/dev_databases/._.DS_Store", b"junk")
        for name, content in (extra_inner or {}).items():
            z.writestr(name, content)
    outer = io.BytesIO()
    with zipfile.ZipFile(outer, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{FOLDER}/dev.json", json.dumps(dev_json_items()))
        z.writestr(f"{FOLDER}/dev.sql", b"not needed")
        z.writestr(f"{FOLDER}/dev_databases.zip", inner.getvalue())
    return outer.getvalue()


def archive_for(content: bytes) -> Archive:
    return Archive(
        url="https://example.test/dev.zip",
        filename="dev.zip",
        sha256=hashlib.sha256(content).hexdigest(),
        size=len(content),
        folder=FOLDER,
    )


class FakeFetch:
    def __init__(self, content: bytes) -> None:
        self.content = content
        self.calls: list[str] = []

    def __call__(self, url: str, dest: Path, max_bytes: int) -> None:
        self.calls.append(url)
        dest.write_bytes(self.content)


class AssistantUnavailableError(Exception):
    """Stands in for notebook_api.ai.pipeline.AssistantUnavailableError (matched by name)."""


class FakeModelClient:
    """Fixed token counts per reply, and scripted stop reasons.

    Questions containing `refuse_on` are always refused. `script` maps a text
    found in the question to the stop reasons of its successive calls
    ("refusal", "max_tokens", ...); calls past the script end normally.
    """

    def __init__(
        self, *, refuse_on: str | None = None, script: dict[str, list[str]] | None = None
    ) -> None:
        self.refuse_on = refuse_on
        self.script = script or {}
        self.seen: dict[str, int] = {}
        self.calls = 0

    async def complete(self, *, system: str, user: str, max_tokens: int) -> ModelReply:
        self.calls += 1
        stop = "end_turn"
        if self.refuse_on and self.refuse_on in user:
            stop = "refusal"
        for text, reasons in self.script.items():
            if text in user:
                index = self.seen.get(text, 0)
                self.seen[text] = index + 1
                if index < len(reasons):
                    stop = reasons[index]
        if stop == "refusal":
            return ModelReply(
                text="",
                input_tokens=900,
                output_tokens=0,
                stop_reason="refusal",
                cache_write_tokens=0,
                cache_read_tokens=0,
            )
        # 1,000 input tokens: 600 uncached, 300 written to the cache, 100 read from it.
        return ModelReply(
            text="```sql\n...\n```",
            input_tokens=1000,
            output_tokens=50,
            stop_reason=stop,
            cache_write_tokens=300,
            cache_read_tokens=100,
        )


@dataclass
class ScriptedGenerate:
    """A stand-in for pipeline.generate_sql with a scripted answer per question.

    `answers[question]` is the SQL of each attempt in order. Like the real
    pipeline it validates each attempt and asks again (up to max_repairs
    times) while there's no valid SQL; each attempt is one model call. A
    refused or cut-off reply is an attempt without SQL (the pipeline doesn't
    raise for those). The result's SQL is the most recent SQL any attempt
    produced. `raise_on` questions make one call and then raise a service
    failure; `raise_after_refusal` questions raise after a refused reply.
    """

    answers: dict[str, list[str]]
    raise_on: set[str] = field(default_factory=set)
    raise_after_refusal: set[str] = field(default_factory=set)
    # Questions whose call after a refusal hits a service failure.
    unavailable_after_refusal: set[str] = field(default_factory=set)
    calls: list[str] = field(default_factory=list)
    output_caps: list[int | None] = field(default_factory=list)

    async def __call__(
        self,
        *,
        question: str,
        schema: SchemaContext,
        validator: Validator,
        client: ModelClient,
        max_repairs: int = 2,
        evidence: str | None = None,
        max_output_tokens: int | None = None,
    ) -> GenerationResult:
        self.calls.append(question)
        self.output_caps.append(max_output_tokens)
        assert schema.text
        if question in self.raise_on:
            await client.complete(system="s", user=question, max_tokens=10)
            raise AssistantUnavailableError("The AI assistant is unavailable right now.")
        attempts: list[Attempt] = []
        for sql in self.answers.get(question, [])[: max_repairs + 1]:
            reply = await client.complete(system="s", user=question, max_tokens=10)
            if reply.stop_reason in ("refusal", "max_tokens"):
                if reply.stop_reason == "refusal" and question in self.raise_after_refusal:
                    raise RuntimeError("pipeline bug after a refusal")
                if reply.stop_reason == "refusal" and question in self.unavailable_after_refusal:
                    raise AssistantUnavailableError("The AI service is busy. Try again.")
                attempts.append(Attempt(None, "no SQL", reply.input_tokens, reply.output_tokens))
                continue
            error = await validator.validate(sql)
            attempts.append(Attempt(sql, error, reply.input_tokens, reply.output_tokens))
            if error is None:
                break
        if not attempts:
            reply = await client.complete(system="s", user=question, max_tokens=10)
            attempts.append(Attempt(None, "no SQL", reply.input_tokens, reply.output_tokens))
        produced = [a for a in attempts if a.sql is not None]
        latest = produced[-1] if produced else None
        return GenerationResult(
            sql=latest.sql if latest else None,
            valid=latest is not None and latest.error is None,
            explanation="scripted",
            attempts=attempts,
        )


def write_taxi_db(path: Path) -> Path:
    """A few trips and zones with the real column names the template's examples use."""
    with duckdb.connect(str(path)) as con:
        con.execute(
            "CREATE TABLE zones (location_id INTEGER, borough VARCHAR, zone VARCHAR, "
            "service_zone VARCHAR)"
        )
        con.execute(
            "INSERT INTO zones VALUES (132, 'Queens', 'JFK Airport', 'Airports'), "
            "(236, 'Manhattan', 'Upper East Side North', 'Yellow Zone')"
        )
        con.execute(
            "CREATE TABLE trips (pickup_at TIMESTAMP, pickup_location_id INTEGER, "
            "payment_type INTEGER, fare_amount DOUBLE, tip_amount DOUBLE, tags VARCHAR[])"
        )
        con.execute(
            "INSERT INTO trips VALUES "
            "('2024-01-05 10:00', 132, 1, 50.0, 10.0, ['a']), "
            "('2024-01-06 11:00', 236, 1, 10.0, 2.0, ['b']), "
            "('2024-02-01 09:00', 236, 2, 12.0, 0.0, ['a', 'b'])"
        )
    return path


class AlwaysValid:
    async def validate(self, sql: str) -> str | None:
        return None


class FakeTaxiWiring:
    def __init__(self, fail_with: Exception | None = None) -> None:
        self.schema_calls = 0
        self.closed = False
        self.fail_with = fail_with

    async def aclose(self) -> None:
        self.closed = True

    async def schema_context(self) -> SchemaContext:
        self.schema_calls += 1
        await asyncio.sleep(0)  # suspends, like reading through a worker pool
        if self.fail_with is not None:
            raise self.fail_with
        return SchemaContext(dialect="duckdb", text="CREATE TABLE trips (...);")

    def validator(self) -> Validator:
        return AlwaysValid()
