"""Turning measured token counts into a dollar figure, from list prices.

The token counts are measured (the API reports them on every reply). The
dollar figure is computed: tokens times the per-model list prices below. It
is not what an invoice says (no discounts, credits or taxes), so every report
labels it "computed from list prices".

Prices copied on 2026-11-13 from Anthropic's pricing page,
https://platform.claude.com/docs/en/about-claude/pricing (base input and
output token rows; the eval sends no cached or batched requests).
Claude Haiku 5.5 is priced by prompt length: a request whose prompt is over
100,000 tokens pays the higher row for that whole request, so each attempt
is priced on its own and such prompts are counted and flagged.
"""

from dataclasses import dataclass

PRICES_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing"
PRICES_COPIED_ON = "2026-11-13"


@dataclass(frozen=True)
class Price:
    input_per_mtok: float  # USD per million input tokens
    output_per_mtok: float  # USD per million output tokens


@dataclass(frozen=True)
class ModelPrices:
    base: Price
    # Prompts with more input tokens than `long_prompt_threshold` pay `long`.
    long_prompt_threshold: int | None = None
    long: Price | None = None


PRICE_TABLE: dict[str, ModelPrices] = {
    "claude-haiku-5-5": ModelPrices(
        base=Price(0.10, 0.50), long_prompt_threshold=100_000, long=Price(0.50, 2.50)
    ),
    "claude-sonnet-5-5": ModelPrices(base=Price(2.00, 10.00)),
    "claude-opus-5-5": ModelPrices(base=Price(4.00, 20.00)),
}


def is_long_prompt(model: str, input_tokens: int) -> bool:
    prices = PRICE_TABLE.get(model)
    return bool(
        prices
        and prices.long_prompt_threshold is not None
        and input_tokens > prices.long_prompt_threshold
    )


def request_cost(model: str, input_tokens: int, output_tokens: int) -> float | None:
    """USD for one request at list prices; None if the model isn't in the table."""
    prices = PRICE_TABLE.get(model)
    if prices is None:
        return None
    price = prices.base
    if prices.long is not None and is_long_prompt(model, input_tokens):
        price = prices.long
    return (input_tokens * price.input_per_mtok + output_tokens * price.output_per_mtok) / 1e6
