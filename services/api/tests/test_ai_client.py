"""The Claude client (against a fake HTTP transport: no real API calls), the fake model, and
the AI settings."""

import json
from collections.abc import Callable
from typing import Any

import httpx2
import pytest
from pydantic import ValidationError

from notebook_api.ai import client as client_module
from notebook_api.ai.client import (
    FAKE_INVALID_SQL,
    FAKE_VALID_SQL,
    AnthropicModelClient,
    FakeModelClient,
)
from notebook_api.ai.pipeline import AssistantUnavailableError
from notebook_api.config import Settings
from tests.fixtures import auth_settings

pytestmark = pytest.mark.anyio

FAKE_KEY = "test-key-not-real"


def _message(
    *,
    content: list[dict[str, Any]] | None = None,
    stop_reason: str = "end_turn",
    model: str = "claude-haiku-5-5",
    usage: dict[str, Any] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    return {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content
        if content is not None
        else [{"type": "text", "text": "```sql\nSELECT 1\n```\nOne."}],
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": usage
        or {
            "input_tokens": 10,
            "output_tokens": 5,
            "cache_creation_input_tokens": 100,
            "cache_read_input_tokens": 900,
        },
        **extra,
    }


class FakeApi:
    """A stand-in for the Anthropic API: records requests, answers from a handler."""

    def __init__(self, answer: Callable[[httpx2.Request], httpx2.Response]) -> None:
        self.requests: list[httpx2.Request] = []
        self._answer = answer

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return self._answer(request)

    def body(self, index: int = 0) -> dict[str, Any]:
        body: dict[str, Any] = json.loads(self.requests[index].content)
        return body


def _client(
    api: FakeApi, model: str = "claude-haiku-5-5", effort: str = "medium", fallbacks: bool = True
) -> AnthropicModelClient:
    return AnthropicModelClient(
        api_key=FAKE_KEY,
        model=model,
        effort=effort,
        fallbacks=fallbacks,
        max_retries=0,
        http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(api.handle)),
    )


def _ok(message: dict[str, Any]) -> Callable[[httpx2.Request], httpx2.Response]:
    return lambda request: httpx2.Response(200, json=message)


async def test_a_request_has_the_model_effort_and_a_cached_system_prompt() -> None:
    api = FakeApi(_ok(_message()))
    reply = await _client(api, effort="low").complete(
        system="RULES", user="QUESTION", max_tokens=99
    )

    body = api.body()
    assert body["model"] == "claude-haiku-5-5"
    assert body["max_tokens"] == 99
    assert body["output_config"] == {"effort": "low"}
    assert body["system"] == [
        {"type": "text", "text": "RULES", "cache_control": {"type": "ephemeral"}}
    ]
    assert body["messages"] == [{"role": "user", "content": "QUESTION"}]
    # Rejected on API version 2026-10-21 (or by these models): never sent.
    for absent in ("temperature", "top_p", "top_k", "thinking", "fallbacks"):
        assert absent not in body
    headers = api.requests[0].headers
    assert headers["anthropic-version"] == "2026-10-21"
    assert "server-side-fallback" not in headers.get("anthropic-beta", "")

    assert reply.text == "```sql\nSELECT 1\n```\nOne."
    assert reply.stop_reason == "end_turn"
    # Input counts uncached, cache-written and cache-read tokens.
    assert (reply.input_tokens, reply.output_tokens) == (1010, 5)
    assert reply.model == "claude-haiku-5-5"


async def test_only_text_blocks_are_the_answer() -> None:
    content = [
        {"type": "thinking", "thinking": "", "signature": "sig"},
        {"type": "text", "text": "A"},
        {"type": "text", "text": "B"},
    ]
    api = FakeApi(_ok(_message(content=content)))
    assert (await _client(api).complete(system="s", user="u", max_tokens=10)).text == "AB"


@pytest.mark.parametrize("model", ["claude-sonnet-5-5", "claude-opus-5-5"])
async def test_sonnet_and_opus_opt_into_the_server_side_fallback(model: str) -> None:
    api = FakeApi(_ok(_message(model=model)))
    await _client(api, model=model).complete(system="s", user="u", max_tokens=10)
    assert api.body()["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in api.requests[0].headers["anthropic-beta"]
    assert api.body()["output_config"] == {"effort": "medium"}


@pytest.mark.parametrize(
    ("model", "fallbacks"),
    [("claude-haiku-5-5", True), ("claude-sonnet-5-5", False), ("claude-opus-5-5", False)],
)
async def test_no_fallback_for_haiku_or_when_turned_off(model: str, fallbacks: bool) -> None:
    api = FakeApi(_ok(_message(model=model)))
    await _client(api, model=model, fallbacks=fallbacks).complete(
        system="s", user="u", max_tokens=10
    )
    assert "fallbacks" not in api.body()
    assert "server-side-fallback" not in api.requests[0].headers.get("anthropic-beta", "")


async def test_a_fallback_reports_the_model_that_answered_and_every_attempts_tokens() -> None:
    message = _message(
        model="claude-opus-4-8",
        content=[
            {
                "type": "fallback",
                "from": {"model": "claude-opus-5-5"},
                "to": {"model": "claude-opus-4-8"},
            },
            {"type": "text", "text": "```sql\nSELECT 2\n```"},
        ],
        usage={
            "input_tokens": 60,
            "output_tokens": 20,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "iterations": [
                {
                    "type": "message",
                    "model": "claude-opus-5-5",
                    "input_tokens": 50,
                    "output_tokens": 0,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0,
                },
                {
                    "type": "fallback_message",
                    "model": "claude-opus-4-8",
                    "input_tokens": 60,
                    "output_tokens": 20,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0,
                },
            ],
        },
    )
    api = FakeApi(_ok(message))
    reply = await _client(api, model="claude-opus-5-5").complete(
        system="s", user="u", max_tokens=10
    )
    assert reply.model == "claude-opus-4-8"
    assert reply.text == "```sql\nSELECT 2\n```"
    assert (reply.input_tokens, reply.output_tokens) == (110, 20)


async def test_a_refusal_has_no_text_even_with_partial_content() -> None:
    message = _message(
        stop_reason="refusal",
        content=[{"type": "text", "text": "partial answer"}],
        stop_details={"type": "refusal", "category": "cyber", "explanation": None},
    )
    api = FakeApi(_ok(message))
    reply = await _client(api).complete(system="s", user="u", max_tokens=10)
    assert reply.stop_reason == "refusal"
    assert reply.text == ""


async def test_max_tokens_is_reported_as_the_stop_reason() -> None:
    api = FakeApi(_ok(_message(stop_reason="max_tokens")))
    reply = await _client(api).complete(system="s", user="u", max_tokens=10)
    assert reply.stop_reason == "max_tokens"


def _error(status: int, error_type: str) -> Callable[[httpx2.Request], httpx2.Response]:
    body = {"type": "error", "error": {"type": error_type, "message": "secret detail"}}
    return lambda request: httpx2.Response(status, json=body)


@pytest.mark.parametrize(
    ("answer", "message"),
    [
        (_error(429, "rate_limit_error"), client_module._BUSY),
        (_error(529, "overloaded_error"), client_module._SERVER_ERROR),
        (_error(500, "api_error"), client_module._SERVER_ERROR),
        (_error(401, "authentication_error"), client_module._CREDENTIALS),
        (_error(403, "permission_error"), client_module._CREDENTIALS),
        (_error(400, "invalid_request_error"), client_module._REJECTED),
    ],
)
async def test_api_errors_become_user_safe_failures(
    answer: Callable[[httpx2.Request], httpx2.Response], message: str
) -> None:
    with pytest.raises(AssistantUnavailableError) as raised:
        await _client(FakeApi(answer)).complete(system="s", user="u", max_tokens=10)
    assert raised.value.message == message
    assert "secret detail" not in raised.value.message


@pytest.mark.parametrize(
    ("exception", "message"),
    [
        (httpx2.ConnectError("refused"), client_module._UNREACHABLE),
        (httpx2.ReadTimeout("slow"), client_module._SLOW),
    ],
)
async def test_network_failures_become_user_safe_failures(
    exception: Exception, message: str
) -> None:
    def fail(request: httpx2.Request) -> httpx2.Response:
        raise exception

    with pytest.raises(AssistantUnavailableError) as raised:
        await _client(FakeApi(fail)).complete(system="s", user="u", max_tokens=10)
    assert raised.value.message == message


async def test_the_key_never_appears_in_a_failure_or_the_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with pytest.raises(AssistantUnavailableError) as raised:
        await _client(FakeApi(_error(401, "authentication_error"))).complete(
            system="s", user="u", max_tokens=10
        )
    assert FAKE_KEY not in str(raised.value)
    assert FAKE_KEY not in caplog.text


def test_the_constructor_checks_its_arguments() -> None:
    with pytest.raises(ValueError):
        AnthropicModelClient(api_key="", model="claude-haiku-5-5", effort="low", fallbacks=False)
    with pytest.raises(ValueError):
        AnthropicModelClient(api_key="k", model="claude-haiku-5-5", effort="max", fallbacks=False)
    haiku = AnthropicModelClient(
        api_key="k", model="claude-haiku-5-5", effort="low", fallbacks=True
    )
    assert haiku.uses_fallbacks is False


# --- the fake model -----------------------------------------------------------


async def test_the_fake_answers_deterministically_and_steers_by_marker() -> None:
    fake = FakeModelClient()
    plain = await fake.complete(system="s", user="<question>\ncount\n</question>", max_tokens=1)
    assert FAKE_VALID_SQL in plain.text
    assert plain == await fake.complete(
        system="s", user="<question>\ncount\n</question>", max_tokens=1
    )
    invalid = await fake.complete(system="s", user="fake-invalid <previous_sql>", max_tokens=1)
    assert FAKE_INVALID_SQL in invalid.text
    first = await fake.complete(system="s", user="fake-repair", max_tokens=1)
    repaired = await fake.complete(system="s", user="fake-repair <previous_sql>", max_tokens=1)
    assert FAKE_INVALID_SQL in first.text and FAKE_VALID_SQL in repaired.text
    refused = await fake.complete(system="s", user="fake-refuse", max_tokens=1)
    assert refused.stop_reason == "refusal"
    explained = await fake.complete(system="s", user="Explain in plain language x", max_tokens=1)
    assert "```" not in explained.text


# --- settings -------------------------------------------------------------------


def test_ai_settings_defaults() -> None:
    settings = Settings()
    assert settings.ai_model == "claude-haiku-5-5"
    assert settings.ai_effort == "medium"
    assert settings.ai_refusal_fallbacks is True
    assert settings.ai_fake_model is False
    assert settings.anthropic_api_key is None


@pytest.mark.parametrize("model", ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"])
def test_the_allowed_models_are_accepted(model: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_MODEL", model)
    assert Settings().ai_model == model


@pytest.mark.parametrize(("name", "value"), [("AI_MODEL", "gpt-4"), ("AI_EFFORT", "max")])
def test_other_models_and_efforts_are_refused(
    name: str, value: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(name, value)
    with pytest.raises(ValidationError):
        Settings()


def test_an_empty_api_key_means_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "  ")
    assert Settings().anthropic_api_key is None


def test_the_fake_model_is_refused_unless_everything_is_local() -> None:
    assert auth_settings(ai_fake_model=True).ai_fake_model is True
    with pytest.raises(ValidationError, match="AI_FAKE_MODEL"):
        Settings(ai_fake_model=True)  # Secure cookies: a real deployment
    with pytest.raises(ValidationError, match="AI_FAKE_MODEL"):
        auth_settings(
            ai_fake_model=True, auth_dev_login=False, api_public_url="https://api.example.com"
        )
