"""Fake model clients and validators for the AI tests. Nothing here touches the network."""

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from notebook_api.ai.pipeline import AssistantUnavailableError, ModelReply


def reply(text: str, stop_reason: str = "end_turn", model: str = "scripted") -> ModelReply:
    return ModelReply(
        text=text, input_tokens=100, output_tokens=10, stop_reason=stop_reason, model=model
    )


def sql_reply(sql: str, explanation: str = "It answers the question.") -> ModelReply:
    return reply(f"```sql\n{sql}\n```\n{explanation}")


@dataclass
class Call:
    system: str
    user: str
    max_tokens: int


@dataclass
class ScriptedClient:
    """Answers each call with the next scripted reply (or raises it); records every call."""

    script: Sequence[ModelReply | Exception | Callable[[str], ModelReply]]
    calls: list[Call] = field(default_factory=list)

    async def complete(self, *, system: str, user: str, max_tokens: int) -> ModelReply:
        self.calls.append(Call(system, user, max_tokens))
        step = self.script[min(len(self.calls), len(self.script)) - 1]
        if isinstance(step, Exception):
            raise step
        if callable(step):
            return step(user)
        return step


@dataclass
class TableValidator:
    """Valid unless the SQL mentions a word in `errors` (which maps to its message)."""

    errors: dict[str, str] = field(default_factory=dict)
    unavailable: bool = False
    seen: list[str] = field(default_factory=list)

    async def validate(self, sql: str) -> str | None:
        self.seen.append(sql)
        if self.unavailable:
            raise AssistantUnavailableError("The query engine is busy.")
        for word, message in self.errors.items():
            if word in sql:
                return message
        return None
