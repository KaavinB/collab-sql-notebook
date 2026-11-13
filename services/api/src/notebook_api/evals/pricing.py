"""Turning measured token counts into a dollar figure, from list prices.

The token counts are measured (the API reports them on every reply). The
dollar figure is computed: tokens times the per-model list prices below. It
is not what an invoice says (no discounts, credits or taxes), so every report
labels it "computed from list prices".

Prices copied on 2026-11-13 from Anthropic's pricing page,
https://platform.claude.com/docs/en/about-claude/pricing. The eval sends no
batched requests, but it does use prompt caching (the assistant marks its
system prompt, which holds the schema, for caching), so input tokens come in
three kinds priced differently: uncached (the base input price), written to
the cache (1.25x base, the 5-minute TTL the client uses) and read from the
cache (Sonnet 5.5 and Opus 5.5: 0.05x base; Haiku 5.5: 0.1x base). A run
recorded without that breakdown can't be priced, and its report says so.
Claude Haiku 5.5 is priced by prompt length: a request whose prompt is over
100,000 tokens pays the higher row for that whole request, so each attempt
is priced on its own and such prompts are counted and flagged.
"""

from dataclasses import dataclass

PRICES_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing"
PRICES_COPIED_ON = "2026-11-13"


# Cache writes cost this multiple of the base input price (5-minute TTL).
CACHE_WRITE_MULTIPLIER = 1.25


@dataclass(frozen=True)
class Price:
    input_per_mtok: float  # USD per million uncached input tokens
    output_per_mtok: float  # USD per million output tokens
    cache_read_multiplier: float  # cache reads cost this multiple of input_per_mtok


@dataclass(frozen=True)
class ModelPrices:
    base: Price
    # Prompts with more input tokens than `long_prompt_threshold` pay `long`.
    long_prompt_threshold: int | None = None
    long: Price | None = None


PRICE_TABLE: dict[str, ModelPrices] = {
    "claude-haiku-5-5": ModelPrices(
        base=Price(0.10, 0.50, 0.1),
        long_prompt_threshold=100_000,
        long=Price(0.50, 2.50, 0.1),
    ),
    "claude-sonnet-5-5": ModelPrices(base=Price(2.00, 10.00, 0.05)),  # cache reads $0.10
    "claude-opus-5-5": ModelPrices(base=Price(4.00, 20.00, 0.05)),  # cache reads $0.20
}


def is_long_prompt(model: str, input_tokens: int) -> bool:
    prices = PRICE_TABLE.get(model)
    return bool(
        prices
        and prices.long_prompt_threshold is not None
        and input_tokens > prices.long_prompt_threshold
    )


def request_cost(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_write_tokens: int,
    cache_read_tokens: int,
) -> float | None:
    """USD for one request at list prices; None if the model isn't in the table.

    `input_tokens` is everything the model read; the cache parts are priced at
    their own rates and the rest at the base input price. Whether a Haiku
    prompt is "long" depends on its whole size, cached parts included.
    """
    prices = PRICE_TABLE.get(model)
    if prices is None:
        return None
    price = prices.base
    if prices.long is not None and is_long_prompt(model, input_tokens):
        price = prices.long
    uncached = max(0, input_tokens - cache_write_tokens - cache_read_tokens)
    dollars = (
        uncached * price.input_per_mtok
        + cache_write_tokens * price.input_per_mtok * CACHE_WRITE_MULTIPLIER
        + cache_read_tokens * price.input_per_mtok * price.cache_read_multiplier
        + output_tokens * price.output_per_mtok
    )
    return dollars / 1e6
