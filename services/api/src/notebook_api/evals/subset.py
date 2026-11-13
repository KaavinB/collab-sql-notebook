"""A deterministic, difficulty-stratified subset of benchmark questions.

Stratified so the subset has the same mix of BIRD's difficulty labels
(simple / moderate / challenging) as the full dev set: a plain random sample
could, by chance, over- or under-represent the hard questions, which would
move the headline accuracy for reasons that have nothing to do with the
model. Each stratum gets its proportional share of `size` (largest-remainder
rounding, so the shares add up to exactly `size`), then a seeded sample is
drawn from it. The same questions, seed and size give the same IDs, and the
IDs are written into every report and run.json.
"""

import random
from collections.abc import Callable, Sequence
from fractions import Fraction
from math import floor


def stratified_sample[T](
    items: Sequence[T],
    *,
    size: int,
    seed: int,
    key: Callable[[T], str],
    stratum: Callable[[T], str],
) -> list[T]:
    """`size` items (or all of them, if fewer), sorted by `key`.

    `key` must be unique per item; items are sorted by it before sampling so
    the input order doesn't change the result.
    """
    if size < 1:
        raise ValueError("size must be at least 1")
    ordered = sorted(items, key=key)
    if len({key(item) for item in ordered}) != len(ordered):
        raise ValueError("item keys must be unique")
    if size >= len(ordered):
        return ordered

    groups: dict[str, list[T]] = {}
    for item in ordered:
        groups.setdefault(stratum(item), []).append(item)
    names = sorted(groups)
    quotas = _allocate(size, {name: len(groups[name]) for name in names})

    # Python guarantees that random() gives the same sequence for the same
    # seed across versions, but not that helpers like sample() or shuffle()
    # keep their algorithms. So only random() is used: every item, in sorted
    # order, draws one number, and each stratum keeps its smallest draws.
    # (To reuse an exact list regardless, a run can take its IDs from an
    # earlier run's run.json.)
    rng = random.Random(seed)  # noqa: S311 - sampling, not security
    chosen: list[T] = []
    for name in names:
        draws = [(rng.random(), index) for index in range(len(groups[name]))]
        keep = sorted(draws)[: quotas[name]]
        chosen.extend(groups[name][index] for _, index in keep)
    return sorted(chosen, key=key)


def _allocate(size: int, counts: dict[str, int]) -> dict[str, int]:
    """Split `size` across strata in proportion to `counts` (largest remainder)."""
    total = sum(counts.values())
    # Exact fractions: float rounding could otherwise move a seat between strata.
    exact = {name: Fraction(size * count, total) for name, count in counts.items()}
    quotas = {name: floor(value) for name, value in exact.items()}
    # Each floor drops less than 1, and the dropped parts sum to a whole
    # number, so fewer than len(counts) seats are left and every stratum that
    # gets one has a fractional share (so it has an item left to give).
    # Ties on the remainder break by name, so the allocation is deterministic.
    leftover = size - sum(quotas.values())
    by_remainder = sorted(counts, key=lambda name: (-(exact[name] - quotas[name]), name))
    for name in by_remainder[:leftover]:
        quotas[name] += 1
    return quotas
