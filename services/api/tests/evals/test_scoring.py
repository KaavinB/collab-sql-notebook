from collections.abc import Hashable

import pytest

from notebook_api.evals.execution import ExecOutcome, ExecStatus
from notebook_api.evals.pricing import is_long_prompt, request_cost
from notebook_api.evals.scoring import is_correct, proportion, wilson_interval


def ok(*rows: tuple[Hashable, ...]) -> ExecOutcome:
    return ExecOutcome("ok", rows=frozenset(rows), row_count=len(rows))


def test_equal_sets_are_correct() -> None:
    assert is_correct(ok((1, "a"), (2, "b")), ok((1, "a"), (2, "b")))


def test_different_rows_or_extra_rows_are_wrong() -> None:
    assert not is_correct(ok((1,)), ok((1,), (2,)))
    assert not is_correct(ok((1, "a")), ok((1, "b")))
    assert not is_correct(ok(), ok((1,)))


def test_int_and_float_compare_like_python_sets_do() -> None:
    # BIRD compares Python sets, where 1 == 1.0.
    assert is_correct(ok((1,)), ok((1.0,)))


def test_failed_predictions_and_failed_gold_are_never_correct() -> None:
    gold = ok((1,))
    statuses: tuple[ExecStatus, ...] = ("error", "timeout", "too_many_rows")
    for status in statuses:
        assert not is_correct(ExecOutcome(status, error="x"), gold)
        assert not is_correct(gold, ExecOutcome(status, error="x"))
    assert not is_correct(ExecOutcome("error"), ExecOutcome("error"))


def test_wilson_interval_known_values() -> None:
    low, high = wilson_interval(5, 10)
    assert low == pytest.approx(0.2366, abs=1e-4)
    assert high == pytest.approx(0.7634, abs=1e-4)
    low, high = wilson_interval(0, 10)
    assert low == 0.0
    assert high == pytest.approx(0.2775, abs=1e-4)
    low, high = wilson_interval(10, 10)
    assert low == pytest.approx(0.7225, abs=1e-4)
    assert high == pytest.approx(1.0)


def test_wilson_interval_edge_cases() -> None:
    assert wilson_interval(0, 0) == (None, None)
    with pytest.raises(ValueError):
        wilson_interval(3, 2)
    with pytest.raises(ValueError):
        wilson_interval(-1, 2)


def test_proportion_describes_n_and_interval() -> None:
    assert proportion(110, 200).describe() == "55.0% (110/200; 95% CI 48.1-61.7%)"
    assert proportion(0, 0).describe() == "n/a (n=0)"
    assert proportion(3, 4).to_json()["n"] == 4


def test_list_price_cost() -> None:
    million = 1_000_000
    assert request_cost("claude-haiku-5-5", million // 10, million // 10, 0, 0) == pytest.approx(
        0.06
    )
    assert request_cost("claude-sonnet-5-5", million, million, 0, 0) == pytest.approx(12.0)
    assert request_cost("claude-opus-5-5", million, million, 0, 0) == pytest.approx(24.0)
    assert request_cost("some-other-model", 10, 10, 0, 0) is None


def test_cache_writes_and_reads_are_priced_at_their_own_rates() -> None:
    # A million input tokens: 400k uncached, 400k written to the cache (1.25x),
    # 200k read from it (0.05x on Opus 5.5 and Sonnet 5.5, 0.1x on Haiku 5.5).
    million = 1_000_000
    opus = request_cost("claude-opus-5-5", million, 0, 400_000, 200_000)
    assert opus == pytest.approx((400_000 * 4 + 400_000 * 4 * 1.25 + 200_000 * 4 * 0.05) / 1e6)
    sonnet = request_cost("claude-sonnet-5-5", million, 0, 0, million)
    assert sonnet == pytest.approx(million * 2 * 0.05 / 1e6)  # $0.10 per million cache reads
    haiku = request_cost("claude-haiku-5-5", million // 10, 0, 0, million // 10)
    assert haiku == pytest.approx(100_000 * 0.10 * 0.1 / 1e6)


def test_haiku_long_prompts_pay_the_higher_rate() -> None:
    assert not is_long_prompt("claude-haiku-5-5", 100_000)
    assert is_long_prompt("claude-haiku-5-5", 100_001)
    assert not is_long_prompt("claude-opus-5-5", 500_000)
    assert not is_long_prompt("unknown", 500_000)
    assert request_cost("claude-haiku-5-5", 100_000, 1_000, 0, 0) == pytest.approx(
        (100_000 * 0.10 + 1_000 * 0.50) / 1e6
    )
    assert request_cost("claude-haiku-5-5", 200_000, 1_000, 0, 0) == pytest.approx(
        (200_000 * 0.50 + 1_000 * 2.50) / 1e6
    )
