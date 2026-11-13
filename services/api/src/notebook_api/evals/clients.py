"""Model clients for the eval: the real one (through a factory) and the dry-run fake."""

import importlib
import os
from collections.abc import Callable
from typing import cast

from notebook_api.ai.pipeline import ModelClient, ModelReply

# (model, effort) -> client. Tests and --dry-run pass their own.
ClientFactory = Callable[[str, str], ModelClient]

EFFORTS = ("low", "medium", "high")
DEFAULT_MODEL = "claude-haiku-5-5"


class EvalSetupError(Exception):
    """Something the run needs is missing; nothing has been spent yet."""


class DryRunModelClient:
    """A fake model for --dry-run: the same fixed reply to every request.

    It reports zero tokens (nothing was spent), so a dry run's report can't
    be mistaken for a measurement. The reply is one fenced SQL block, the
    format the pipeline parses.
    """

    REPLY = "```sql\nSELECT 1\n```\nA fixed dry-run answer."

    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, *, system: str, user: str, max_tokens: int) -> ModelReply:
        self.calls += 1
        return ModelReply(text=self.REPLY, input_tokens=0, output_tokens=0, stop_reason="end_turn")


def dry_run_client_factory(model: str, effort: str) -> ModelClient:
    return DryRunModelClient()


def anthropic_client_factory(model: str, effort: str) -> ModelClient:
    """The real client from the AI service, configured for measuring one model alone.

    Server-side fallbacks are always off: with them on, a refused request
    could be answered by a different model, and the score would no longer
    be this model's. A refusal stays a refusal and counts as wrong.

    The key is read from ANTHROPIC_API_KEY and never printed.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise EvalSetupError("ANTHROPIC_API_KEY is not set; a real run needs it")
    try:
        module = importlib.import_module("notebook_api.ai.client")
    except ImportError:
        raise EvalSetupError("notebook_api.ai.client is not available in this checkout") from None
    client_class = module.AnthropicModelClient
    try:
        client = client_class(api_key=api_key, model=model, effort=effort, fallbacks=False)
    except ValueError as error:
        # The client refuses an empty key or an unknown effort. Its message
        # is shown, with the key masked in case it were ever echoed.
        message = str(error).replace(api_key, "***")
        raise EvalSetupError(f"could not set up the model client for {model}: {message}") from None
    return cast(ModelClient, client)
