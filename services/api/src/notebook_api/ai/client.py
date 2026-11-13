"""Model clients: Claude through the official SDK, and a deterministic fake for tests.

AnthropicModelClient makes one Messages API call per `complete()`:

- The system prompt (rules + schema) is sent as one text block marked for
  prompt caching. It's identical for every request against the same
  database, and only the user message after it varies, so repeated
  requests can reuse the cached prefix. Whether they do shows up in the
  response's cache token counts; nothing here assumes a saving.
- `output_config.effort` is always sent, so every model in the allowlist
  thinks at the same configured level (their defaults differ). Thinking is
  left adaptive (the parameter is omitted): Opus 5.5 rejects turning it
  off, and no sampling parameters are sent (API version 2026-10-21, which
  the 2.x SDK uses, rejects them).
- Refusals: the response is checked for `stop_reason == "refusal"` before its
  content is read. With `fallbacks=True`, Sonnet 5.5 and Opus 5.5 requests
  opt into the server-side fallback (the API retries a declined request on
  the model Anthropic recommends for that kind of refusal, in the same
  call). Haiku 5.5 has no server-side fallback, so the flag is ignored
  there. A refusal that comes back anyway means the whole chain declined.
- SDK errors (rate limit, overload, server error, timeout, lost connection,
  bad credentials) become AssistantUnavailableError with a message that is
  safe to show users; details go to the log, never the key.
"""

import asyncio
import logging
from typing import Any, Final

import anthropic
import httpx2
from anthropic import AsyncAnthropic

from notebook_api.ai.pipeline import AssistantUnavailableError, ModelReply

logger = logging.getLogger(__name__)

# One model call's time limit. A reply is bounded by pipeline.MAX_OUTPUT_TOKENS
# (thinking included), so a healthy call fits well inside it; a call that
# doesn't is better failed than left hanging while a person waits. Not
# measured: a generous bound on a few-thousand-token reply.
REQUEST_TIMEOUT_SECONDS = 60.0
# The SDK retries connection errors, 408, 409, 429 and 5xx with backoff. One
# retry rides out a blip; more would keep a person waiting through an outage
# (a request can make up to three model calls, each retried).
MAX_RETRIES = 1

EFFORTS: Final = frozenset({"low", "medium", "high"})
# Models with a server-side refusal fallback. Haiku 5.5 has none: sending the
# parameter there doesn't help (and a list of models is rejected).
FALLBACK_MODELS: Final = frozenset({"claude-sonnet-5-5", "claude-opus-5-5"})
FALLBACK_BETA: Final = "server-side-fallback-2026-07-01"

_BUSY = "The AI service is busy right now. Try again in a minute."
_SLOW = "The AI service took too long to answer. Try again."
_UNREACHABLE = "Couldn't reach the AI service. Try again in a moment."
_SERVER_ERROR = "The AI service had a problem answering. Try again in a moment."
_CREDENTIALS = "The AI assistant isn't set up correctly on the server (its API key was refused)."
_REJECTED = "The AI service couldn't process this request."


class AnthropicModelClient:
    """The real ModelClient: Claude through `anthropic.AsyncAnthropic`."""

    def __init__(
        self,
        api_key: str,
        model: str,
        effort: str,
        fallbacks: bool,
        *,
        timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
        max_retries: int = MAX_RETRIES,
        http_client: httpx2.AsyncClient | None = None,
    ) -> None:
        """`http_client` replaces the network (tests); production leaves it unset."""
        if not api_key:
            raise ValueError("api_key is required")
        if effort not in EFFORTS:
            raise ValueError(f"effort must be one of {sorted(EFFORTS)}")
        self.model = model
        self.effort = effort
        self.uses_fallbacks = fallbacks and model in FALLBACK_MODELS
        # The key is passed explicitly, so the SDK reads no credential from
        # the environment or a profile on disk.
        self._sdk = AsyncAnthropic(
            api_key=api_key,
            timeout=timeout_seconds,
            max_retries=max_retries,
            http_client=http_client,
        )

    async def close(self) -> None:
        await self._sdk.close()

    async def complete(self, *, system: str, user: str, max_tokens: int) -> ModelReply:
        try:
            message = await self._create(system=system, user=user, max_tokens=max_tokens)
        except anthropic.APIStatusError as error:
            raise _status_error(error) from None
        except anthropic.APITimeoutError:  # before APIConnectionError: it's a subclass
            logger.warning("Anthropic API call timed out")
            raise AssistantUnavailableError(_SLOW) from None
        except anthropic.APIConnectionError:
            logger.warning("Anthropic API connection failed", exc_info=True)
            raise AssistantUnavailableError(_UNREACHABLE) from None
        except anthropic.AnthropicError:
            # Anything else the SDK raises (a response that doesn't parse,
            # a credentials problem): the call failed, not the request.
            logger.exception("Anthropic API call failed")
            raise AssistantUnavailableError(_SERVER_ERROR) from None
        return _reply(message)

    async def _create(self, *, system: str, user: str, max_tokens: int) -> Any:
        system_blocks: Any = [
            {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
        ]
        messages: Any = [{"role": "user", "content": user}]
        output_config: Any = {"effort": self.effort}
        if self.uses_fallbacks:
            return await self._sdk.beta.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                system=system_blocks,
                messages=messages,
                output_config=output_config,
                betas=[FALLBACK_BETA],
                fallbacks="default",
            )
        return await self._sdk.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            system=system_blocks,
            messages=messages,
            output_config=output_config,
        )


def _status_error(error: anthropic.APIStatusError) -> AssistantUnavailableError:
    # Logged: the status, the API's error type and request ID (for support).
    # Not logged: the request (it holds the person's question) or the key.
    logger.warning(
        "Anthropic API error: status %s, type %s, request %s",
        error.status_code,
        error.type,
        error.request_id,
    )
    if isinstance(error, anthropic.RateLimitError):
        return AssistantUnavailableError(_BUSY)
    if isinstance(error, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return AssistantUnavailableError(_CREDENTIALS)
    if error.status_code >= 500 or isinstance(error, anthropic.OverloadedError):
        return AssistantUnavailableError(_SERVER_ERROR)
    return AssistantUnavailableError(_REJECTED)


def _reply(message: Any) -> ModelReply:
    """The ModelReply for a Messages API response (plain or beta)."""
    stop_reason: str | None = message.stop_reason
    if stop_reason == "refusal":
        # A classifier or the model declined. The content is empty or a
        # partial answer that must not be used.
        details = message.stop_details
        logger.info("model refused: category %s", getattr(details, "category", None))
        text = ""
    else:
        # Thinking blocks (and a fallback marker block) come before the
        # answer; only text blocks are the answer.
        text = "".join(block.text for block in message.content if block.type == "text")
    input_tokens, output_tokens = _tokens(message.usage)
    return ModelReply(
        text=text,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        stop_reason=stop_reason,
        model=str(message.model),
    )


def _tokens(usage: Any) -> tuple[int, int]:
    """Input and output tokens for the whole call.

    Input counts every token the model read: uncached, written to the cache
    and read from it (the API reports them separately; the sum is what the
    prompt cost in tokens, not in money). After a refusal fallback the
    top-level usage covers only the attempt that answered, so the
    per-attempt `iterations` are summed instead when present.
    """
    parts = getattr(usage, "iterations", None) or [usage]
    input_tokens = output_tokens = 0
    for part in parts:
        input_tokens += (
            (getattr(part, "input_tokens", 0) or 0)
            + (getattr(part, "cache_creation_input_tokens", 0) or 0)
            + (getattr(part, "cache_read_input_tokens", 0) or 0)
        )
        output_tokens += getattr(part, "output_tokens", 0) or 0
    return input_tokens, output_tokens


# --- the deterministic fake (AI_FAKE_MODEL=true) ----------------------------------

# Words in a question that steer the fake, so end-to-end tests can reach
# every path without a key:
FAKE_INVALID = "fake-invalid"  # every answer fails validation
FAKE_REPAIR = "fake-repair"  # the first answer fails, the repaired one is valid
FAKE_REFUSE = "fake-refuse"  # the model declines
FAKE_SLOW = "fake-slow"  # answers after FAKE_SLOW_SECONDS (to see the "thinking" state)
FAKE_SLOW_SECONDS = 2.0

FAKE_MODEL_NAME = "fake-model"
FAKE_VALID_SQL = "SELECT count(*) AS trip_count FROM trips"
FAKE_INVALID_SQL = "SELECT no_such_column FROM trips"
FAKE_EXPLANATION = "This query reads the trips table and returns what it selects."


class FakeModelClient:
    """Canned replies keyed on the request, for tests and local e2e runs.

    The answers use the taxi database's `trips` table. Token counts are
    derived from text lengths so logs have plausible, deterministic values;
    they are not real token counts.
    """

    async def complete(self, *, system: str, user: str, max_tokens: int) -> ModelReply:
        lowered = user.lower()
        if FAKE_SLOW in lowered:
            await asyncio.sleep(FAKE_SLOW_SECONDS)
        if FAKE_REFUSE in lowered:
            return self._reply(system, user, "", "refusal")
        if lowered.startswith("explain in plain language"):
            return self._reply(system, user, FAKE_EXPLANATION, "end_turn")
        repairing = "<previous_sql>" in lowered
        failing = FAKE_INVALID in lowered or (FAKE_REPAIR in lowered and not repairing)
        sql = FAKE_INVALID_SQL if failing else FAKE_VALID_SQL
        text = f"```sql\n{sql}\n```\nThis counts the trips in the trips table."
        return self._reply(system, user, text, "end_turn")

    @staticmethod
    def _reply(system: str, user: str, text: str, stop_reason: str) -> ModelReply:
        return ModelReply(
            text=text,
            input_tokens=(len(system) + len(user)) // 4,
            output_tokens=len(text) // 4,
            stop_reason=stop_reason,
            model=FAKE_MODEL_NAME,
        )
