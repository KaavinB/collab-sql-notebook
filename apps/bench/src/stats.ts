/**
 * Summary statistics computed from raw samples.
 *
 * Percentile method: nearest rank. The p-th percentile of n sorted samples is
 * the sample at 1-based rank ceil(p/100 * n), so every reported percentile is
 * a value that was actually observed (no interpolation between two samples).
 * With n = 20, p95 is the 19th smallest sample; with n = 10 it is the largest.
 *
 * Deliveries that never arrived ("missing") can be counted as +Infinity.
 * Leaving them out would make a server that drops or stalls messages look
 * faster than one that delivers them late, so the load test counts them: if
 * more than 5% of expected deliveries are missing, p95 is Infinity.
 */

export interface Summary {
  /** Samples observed (finite values). */
  count: number;
  /** Expected deliveries that never arrived, counted as +Infinity. */
  missing: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  /** Mean of the observed samples only (missing ones have no value to average). */
  mean: number | null;
}

/** Nearest-rank percentile of an ascending-sorted array; null when it's empty. */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number | null {
  if (!(p > 0 && p <= 100)) throw new RangeError(`percentile must be in (0, 100], got ${p}`);
  const n = sorted.length;
  if (n === 0) return null;
  const rank = Math.ceil((p / 100) * n);
  return sorted[Math.min(n, Math.max(1, rank)) - 1]!;
}

/**
 * Summarizes `values` (in any order; not modified). `missing` extra samples
 * are treated as +Infinity for the percentiles and the max.
 */
export function summarize(values: ArrayLike<number>, missing = 0): Summary {
  if (!Number.isInteger(missing) || missing < 0) {
    throw new RangeError(`missing must be a non-negative integer, got ${missing}`);
  }
  const sorted = new Float64Array(values.length + missing);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (!Number.isFinite(value)) throw new RangeError(`sample ${i} is not finite: ${value}`);
    sorted[i] = value;
    sum += value;
  }
  sorted.fill(Infinity, values.length);
  sorted.sort();
  const count = values.length;
  return {
    count,
    missing,
    min: sorted.length ? sorted[0]! : null,
    p50: percentileSorted(sorted, 50),
    p95: percentileSorted(sorted, 95),
    p99: percentileSorted(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1]! : null,
    mean: count ? sum / count : null,
  };
}
