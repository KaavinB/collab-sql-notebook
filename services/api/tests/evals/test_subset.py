import random
from collections import Counter
from dataclasses import dataclass

import pytest

from notebook_api.evals.subset import stratified_sample


@dataclass(frozen=True)
class Item:
    id: int
    difficulty: str


def bird_like() -> list[Item]:
    # The same label mix as BIRD dev: 925 simple, 464 moderate, 145 challenging.
    labels = ["simple"] * 925 + ["moderate"] * 464 + ["challenging"] * 145
    return [Item(i, label) for i, label in enumerate(labels)]


def sample(items: list[Item], size: int, seed: int) -> list[Item]:
    return stratified_sample(
        items, size=size, seed=seed, key=lambda x: f"{x.id:09d}", stratum=lambda x: x.difficulty
    )


def test_same_seed_same_ids_whatever_the_input_order() -> None:
    items = bird_like()
    shuffled = items[:]
    random.Random(7).shuffle(shuffled)  # noqa: S311 - test data, not security
    assert sample(items, 200, 1) == sample(shuffled, 200, 1)


def test_selection_is_pinned() -> None:
    # Guards reproducibility across refactors: if this changes, the question
    # IDs in old reports no longer match what a rerun with that seed picks.
    assert [x.id for x in sample(bird_like(), 5, 20261113)] == PINNED_IDS


# Recorded from this implementation; see the test above.
PINNED_IDS = [110, 401, 570, 1083, 1155]


def test_different_seed_different_sample() -> None:
    assert sample(bird_like(), 200, 1) != sample(bird_like(), 200, 2)


def test_strata_are_proportional_and_sum_to_size() -> None:
    picked = sample(bird_like(), 200, 1)
    assert len(picked) == 200
    # 200 * 925/1534 = 120.6, 200 * 464/1534 = 60.5, 200 * 145/1534 = 18.9:
    # floors 120 + 60 + 18 = 198; the two seats left go to the largest
    # remainders (challenging .9, simple .6).
    assert Counter(x.difficulty for x in picked) == {
        "simple": 121,
        "moderate": 60,
        "challenging": 19,
    }


def test_a_pilot_keeps_the_mix() -> None:
    # 10 * 925/1534 = 6.03, 10 * 464/1534 = 3.02, 10 * 145/1534 = 0.95.
    picked = sample(bird_like(), 10, 3)
    assert Counter(x.difficulty for x in picked) == {"simple": 6, "moderate": 3, "challenging": 1}


def test_size_at_least_everything_returns_everything_sorted() -> None:
    items = [Item(3, "a"), Item(1, "b"), Item(2, "a")]
    assert [x.id for x in sample(items, 5, 0)] == [1, 2, 3]


def test_rejects_bad_size_and_duplicate_keys() -> None:
    with pytest.raises(ValueError):
        sample(bird_like(), 0, 1)
    with pytest.raises(ValueError):
        sample([Item(1, "a"), Item(1, "b")], 1, 1)
