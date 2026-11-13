import asyncio
import sys
import types
from collections.abc import Iterator
from typing import Any, ClassVar

import pytest

from notebook_api.evals.clients import (
    DryRunModelClient,
    EvalSetupError,
    anthropic_client_factory,
)

KEY = "sk-test-not-a-real-key-123456"


class FakeAnthropicModelClient:
    """Mirrors the real constructor: (api_key, model, effort, fallbacks, *, ...)."""

    created: ClassVar[list[dict[str, Any]]] = []

    def __init__(
        self,
        api_key: str,
        model: str,
        effort: str,
        fallbacks: bool,
        *,
        timeout_seconds: float = 60.0,
        max_retries: int = 2,
        http_client: object = None,
    ) -> None:
        if not api_key:
            raise ValueError("an API key is required")
        if effort not in ("low", "medium", "high"):
            raise ValueError(f"unknown effort {effort!r} (key {api_key})")
        FakeAnthropicModelClient.created.append(
            {"api_key": api_key, "model": model, "effort": effort, "fallbacks": fallbacks}
        )


@pytest.fixture
def fake_client_module(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    module = types.ModuleType("notebook_api.ai.client")
    module.AnthropicModelClient = FakeAnthropicModelClient  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "notebook_api.ai.client", module)
    FakeAnthropicModelClient.created = []
    yield


def test_missing_key_is_a_setup_error(
    fake_client_module: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(EvalSetupError, match="ANTHROPIC_API_KEY"):
        anthropic_client_factory("claude-haiku-5-5", "medium")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "   ")
    with pytest.raises(EvalSetupError, match="ANTHROPIC_API_KEY"):
        anthropic_client_factory("claude-haiku-5-5", "medium")


def test_effort_is_passed_and_fallbacks_are_always_off(
    fake_client_module: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
    anthropic_client_factory("claude-opus-5-5", "high")
    assert FakeAnthropicModelClient.created == [
        {"api_key": KEY, "model": "claude-opus-5-5", "effort": "high", "fallbacks": False}
    ]


def test_client_value_errors_become_clean_setup_errors_without_the_key(
    fake_client_module: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
    with pytest.raises(EvalSetupError) as caught:
        anthropic_client_factory("claude-haiku-5-5", "extreme")
    assert "unknown effort" in str(caught.value)
    assert KEY not in str(caught.value)


def test_missing_client_module_is_a_setup_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
    monkeypatch.setitem(sys.modules, "notebook_api.ai.client", None)
    with pytest.raises(EvalSetupError, match="not available"):
        anthropic_client_factory("claude-haiku-5-5", "medium")


def test_dry_run_client_spends_nothing() -> None:
    reply = asyncio.run(DryRunModelClient().complete(system="s", user="u", max_tokens=10))
    assert reply.input_tokens == 0 and reply.output_tokens == 0
    assert "```sql" in reply.text
