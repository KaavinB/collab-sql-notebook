"""The text-to-SQL pipeline: validation, the repair loop, refusals and cut-off replies."""

import pytest

from notebook_api.ai import pipeline
from notebook_api.ai.pipeline import (
    AssistantUnavailableError,
    SchemaContext,
    explain_sql,
    fix_sql,
    generate_sql,
)
from tests.ai_fakes import ScriptedClient, TableValidator, reply, sql_reply

pytestmark = pytest.mark.anyio

SCHEMA = SchemaContext(dialect="duckdb", text="Table trips\n  - fare_amount DOUBLE")
BROKEN = {"nope": "Binder Error: column nope not found"}


async def test_a_valid_first_answer_takes_one_call() -> None:
    client = ScriptedClient([sql_reply("SELECT count(*) FROM trips", "Counts trips.")])
    result = await generate_sql(
        question="How many trips?", schema=SCHEMA, validator=TableValidator(), client=client
    )
    assert result.valid is True
    assert result.sql == "SELECT count(*) FROM trips"
    assert result.explanation == "Counts trips."
    assert len(result.attempts) == 1 and result.attempts[0].error is None
    assert result.attempts[0].model == "scripted"
    call = client.calls[0]
    assert "Table trips" in call.system and "How many trips?" in call.user
    assert call.max_tokens == pipeline.MAX_OUTPUT_TOKENS


async def test_fails_twice_then_succeeds() -> None:
    client = ScriptedClient(
        [
            sql_reply("SELECT nope FROM trips"),
            reply("I'm not sure what to write."),
            sql_reply("SELECT fare_amount FROM trips", "Lists fares."),
        ]
    )
    validator = TableValidator(BROKEN)
    result = await generate_sql(
        question="fares?", schema=SCHEMA, validator=validator, client=client
    )
    assert result.valid is True
    assert result.sql == "SELECT fare_amount FROM trips"
    assert [a.sql for a in result.attempts] == [
        "SELECT nope FROM trips",
        None,
        "SELECT fare_amount FROM trips",
    ]
    assert result.attempts[0].error == BROKEN["nope"]
    assert result.attempts[1].error == pipeline.NO_SQL
    # Each repair repeats the task and feeds back what went wrong.
    assert "fares?" in client.calls[1].user
    assert "SELECT nope FROM trips" in client.calls[1].user
    assert BROKEN["nope"] in client.calls[1].user
    assert pipeline.NO_SQL in client.calls[2].user
    # The system prompt (rules + schema) is the same on every call: cacheable.
    assert len({call.system for call in client.calls}) == 1


async def test_never_valid_gives_the_last_query_marked_invalid_after_three_attempts() -> None:
    client = ScriptedClient([sql_reply("SELECT nope FROM trips", "Shows nope.")])
    result = await generate_sql(
        question="q", schema=SCHEMA, validator=TableValidator(BROKEN), client=client
    )
    assert len(client.calls) == 3 and len(result.attempts) == 3
    assert result.valid is False
    assert result.sql == "SELECT nope FROM trips"
    assert result.explanation.startswith("Shows nope.")
    assert "did not pass validation" in result.explanation


async def test_the_output_cap_is_a_parameter_and_cut_offs_stay_recognisable() -> None:
    client = ScriptedClient([reply("```sql\nSELECT", stop_reason="max_tokens")])
    result = await generate_sql(
        question="q",
        schema=SCHEMA,
        validator=TableValidator(),
        client=client,
        max_output_tokens=123,
    )
    assert [call.max_tokens for call in client.calls] == [123, 123, 123]
    assert [a.error for a in result.attempts] == [pipeline.CUT_OFF] * 3
    fix_client = ScriptedClient([sql_reply("SELECT 1")])
    await fix_sql(
        sql="x",
        error="y",
        schema=SCHEMA,
        validator=TableValidator(),
        client=fix_client,
        max_output_tokens=50,
    )
    explain_client = ScriptedClient([reply("It counts.")])
    await explain_sql(sql="x", schema=SCHEMA, client=explain_client, max_output_tokens=60)
    assert (fix_client.calls[0].max_tokens, explain_client.calls[0].max_tokens) == (50, 60)
    with pytest.raises(ValueError):
        await generate_sql(
            question="q",
            schema=SCHEMA,
            validator=TableValidator(),
            client=client,
            max_output_tokens=0,
        )


async def test_max_repairs_zero_makes_exactly_one_call() -> None:
    client = ScriptedClient([sql_reply("SELECT nope FROM trips")])
    result = await generate_sql(
        question="q",
        schema=SCHEMA,
        validator=TableValidator(BROKEN),
        client=client,
        max_repairs=0,
    )
    assert len(client.calls) == 1
    assert result.valid is False and len(result.attempts) == 1


async def test_a_negative_repair_count_is_refused() -> None:
    with pytest.raises(ValueError):
        await generate_sql(
            question="q",
            schema=SCHEMA,
            validator=TableValidator(),
            client=ScriptedClient([]),
            max_repairs=-1,
        )


async def test_evidence_reaches_the_prompt() -> None:
    client = ScriptedClient([sql_reply("SELECT 1")])
    await generate_sql(
        question="q",
        schema=SCHEMA,
        validator=TableValidator(),
        client=client,
        evidence="fare refers to fare_amount",
    )
    assert "fare refers to fare_amount" in client.calls[0].user


async def test_no_query_in_any_attempt_gives_no_sql() -> None:
    client = ScriptedClient([reply("I can't help with that question.")])
    result = await generate_sql(
        question="q", schema=SCHEMA, validator=TableValidator(), client=client
    )
    assert result.sql is None and result.valid is False
    assert result.explanation == pipeline.NO_QUERY
    assert len(result.attempts) == 3


async def test_a_refusal_ends_the_loop_at_once() -> None:
    client = ScriptedClient([reply("", stop_reason="refusal")])
    result = await generate_sql(
        question="q", schema=SCHEMA, validator=TableValidator(), client=client
    )
    assert len(client.calls) == 1
    assert result.sql is None and result.valid is False
    assert result.explanation == pipeline.REFUSED
    assert result.attempts[0].error == pipeline.REFUSED


async def test_a_refusal_after_an_invalid_query_keeps_that_query() -> None:
    client = ScriptedClient([sql_reply("SELECT nope FROM trips"), reply("", stop_reason="refusal")])
    result = await generate_sql(
        question="q", schema=SCHEMA, validator=TableValidator(BROKEN), client=client
    )
    assert len(client.calls) == 2
    assert result.sql == "SELECT nope FROM trips" and result.valid is False


async def test_a_cut_off_reply_is_not_used_even_if_it_parses() -> None:
    validator = TableValidator()
    client = ScriptedClient(
        [
            reply("```sql\nSELECT 1\n```", stop_reason="max_tokens"),
            sql_reply("SELECT 2"),
        ]
    )
    result = await generate_sql(question="q", schema=SCHEMA, validator=validator, client=client)
    assert result.attempts[0].sql is None
    assert result.attempts[0].error == pipeline.CUT_OFF
    assert validator.seen == ["SELECT 2"]  # the cut-off reply never reached validation
    assert pipeline.CUT_OFF in client.calls[1].user
    assert result.sql == "SELECT 2" and result.valid is True


async def test_an_overlong_query_is_not_validated() -> None:
    validator = TableValidator()
    huge = "SELECT " + ", ".join(["1"] * 8000)
    client = ScriptedClient([sql_reply(huge), sql_reply("SELECT 1")])
    result = await generate_sql(question="q", schema=SCHEMA, validator=validator, client=client)
    assert result.attempts[0].error == pipeline.TOO_LONG
    assert validator.seen == ["SELECT 1"]


async def test_a_model_failure_carries_the_attempts_made_so_far() -> None:
    client = ScriptedClient(
        [sql_reply("SELECT nope FROM trips"), AssistantUnavailableError("busy")]
    )
    with pytest.raises(AssistantUnavailableError) as raised:
        await generate_sql(
            question="q", schema=SCHEMA, validator=TableValidator(BROKEN), client=client
        )
    assert raised.value.message == "busy"
    assert [a.sql for a in raised.value.attempts] == ["SELECT nope FROM trips"]


async def test_a_validator_failure_carries_the_attempts_too() -> None:
    client = ScriptedClient([sql_reply("SELECT 1")])
    with pytest.raises(AssistantUnavailableError) as raised:
        await generate_sql(
            question="q",
            schema=SCHEMA,
            validator=TableValidator(unavailable=True),
            client=client,
        )
    assert raised.value.attempts == []


async def test_fix_sends_the_sql_and_its_error() -> None:
    client = ScriptedClient(
        [sql_reply("SELECT fare_amount FROM trips", "The column was misnamed.")]
    )
    result = await fix_sql(
        sql="SELECT fare FROM trips",
        error="Binder Error: fare",
        schema=SCHEMA,
        validator=TableValidator(),
        client=client,
    )
    assert result.valid is True and result.sql == "SELECT fare_amount FROM trips"
    assert "SELECT fare FROM trips" in client.calls[0].user
    assert "Binder Error: fare" in client.calls[0].user


async def test_explain_returns_prose_and_no_sql() -> None:
    client = ScriptedClient([reply("It counts trips.\n```sql\nSELECT 1\n```")])
    result = await explain_sql(sql="SELECT count(*) FROM trips", schema=SCHEMA, client=client)
    assert result.sql is None
    assert result.explanation == "It counts trips."
    assert len(result.attempts) == 1 and result.attempts[0].error is None
    assert "SELECT count(*) FROM trips" in client.calls[0].user


@pytest.mark.parametrize(
    ("model_reply", "expected"),
    [
        (reply("", stop_reason="refusal"), pipeline.REFUSED),
        (reply("It count", stop_reason="max_tokens"), pipeline.CUT_OFF),
        (reply("   "), pipeline.NO_EXPLANATION),
    ],
)
async def test_explain_failures_say_why(model_reply: pipeline.ModelReply, expected: str) -> None:
    result = await explain_sql(sql="SELECT 1", schema=SCHEMA, client=ScriptedClient([model_reply]))
    assert result.attempts[0].error == expected
    assert result.explanation == expected
