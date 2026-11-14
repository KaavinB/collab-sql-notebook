"""Execution accuracy, scored the way BIRD scores it, and its confidence interval.

BIRD's rule: run the gold SQL and the predicted SQL on the same database;
the prediction is correct iff the two results are equal as sets of rows
(`set(predicted) == set(gold)`), so row order and duplicate rows don't
matter, and column names don't either. A prediction that errors, times out
or returns more rows than the cap is wrong.

Where this harness differs from BIRD's official script (each is said in the
report too):
- A question whose gold SQL itself fails (error, timeout, over the row cap)
  is excluded from the rates and listed; BIRD's script counts it as wrong.
- Text that isn't valid UTF-8 is read with the bad bytes replaced, for gold
  and predicted results alike; BIRD's script would fail on it.
- The per-query timeout and row cap are this harness's (recorded per run);
  BIRD's script stops queries after 30 s and has no row cap.
- Numbers are compared by value, whatever their type: a DECIMAL 15.74
  equals a DOUBLE 15.74. DuckDB returns DECIMAL for some casts and for
  rounding written the Postgres way (`round(x::numeric, 2)`), and an answer
  with the right numbers shouldn't be scored wrong for its type. (BIRD's
  SQLite databases have no DECIMAL, so this changes nothing there.)
"""

from dataclasses import dataclass
from decimal import Decimal
from math import sqrt
from typing import Any

from notebook_api.evals.execution import ExecOutcome

# z for a two-sided 95% interval.
_Z95 = 1.959963984540054


def is_correct(predicted: ExecOutcome, gold: ExecOutcome) -> bool:
    if predicted.status != "ok" or gold.status != "ok":
        return False
    if predicted.rows is None or gold.rows is None:
        return False
    if predicted.rows == gold.rows:
        return True
    return _by_value(predicted.rows) == _by_value(gold.rows)


def _by_value(rows: frozenset[Any]) -> frozenset[Any]:
    """The rows with every DECIMAL as a float, so equal numbers compare equal."""
    return frozenset(_number(row) for row in rows)


def _number(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, tuple):
        return tuple(_number(v) for v in value)
    return value


@dataclass(frozen=True)
class Proportion:
    successes: int
    n: int
    low: float | None  # 95% Wilson interval; None when n is 0
    high: float | None

    @property
    def rate(self) -> float | None:
        return self.successes / self.n if self.n else None

    def to_json(self) -> dict[str, object]:
        return {
            "successes": self.successes,
            "n": self.n,
            "rate": self.rate,
            "wilson95_low": self.low,
            "wilson95_high": self.high,
        }

    def describe(self) -> str:
        """e.g. '55.0% (110/200; 95% CI 48.1-61.7%)', or 'n/a (n=0)'."""
        if not self.n or self.rate is None or self.low is None or self.high is None:
            return "n/a (n=0)"
        return (
            f"{self.rate * 100:.1f}% ({self.successes}/{self.n}; "
            f"95% CI {self.low * 100:.1f}-{self.high * 100:.1f}%)"
        )


def proportion(successes: int, n: int) -> Proportion:
    low, high = wilson_interval(successes, n)
    return Proportion(successes, n, low, high)


def wilson_interval(successes: int, n: int, z: float = _Z95) -> tuple[float | None, float | None]:
    """The Wilson score interval for a binomial proportion.

    Chosen over the plain p ± z·sqrt(p(1-p)/n) interval because that one
    collapses to zero width at 0% or 100% and is badly off for small n
    (a pilot of 10 questions); Wilson stays inside [0, 1] and behaves there.
    """
    if n < 0 or successes < 0 or successes > n:
        raise ValueError("need 0 <= successes <= n")
    if n == 0:
        return None, None
    p = successes / n
    z2 = z * z
    denominator = 1 + z2 / n
    center = (p + z2 / (2 * n)) / denominator
    half = z * sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denominator
    return max(0.0, center - half), min(1.0, center + half)
