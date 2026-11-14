import { describe, expect, it } from "vitest";

import { percentileSorted, summarize } from "../src/stats.ts";

describe("percentileSorted (nearest rank)", () => {
  const oneToTwenty = Float64Array.from({ length: 20 }, (_, i) => i + 1);

  it("returns an observed sample at rank ceil(p/100 * n)", () => {
    expect(percentileSorted(oneToTwenty, 50)).toBe(10);
    expect(percentileSorted(oneToTwenty, 95)).toBe(19);
    expect(percentileSorted(oneToTwenty, 99)).toBe(20);
    expect(percentileSorted(oneToTwenty, 100)).toBe(20);
    expect(percentileSorted(oneToTwenty, 5)).toBe(1);
    expect(percentileSorted(oneToTwenty, 0.1)).toBe(1);
  });

  it("never interpolates between two samples", () => {
    expect(percentileSorted([10, 20], 50)).toBe(10);
    expect(percentileSorted([10, 20], 51)).toBe(20);
    expect(percentileSorted([1, 2, 3, 4], 50)).toBe(2);
  });

  it("is the largest sample for p95 of fewer than 20 samples", () => {
    expect(percentileSorted([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  it("is null for no samples and rejects percentiles outside (0, 100]", () => {
    expect(percentileSorted([], 50)).toBeNull();
    expect(() => percentileSorted([1], 0)).toThrow(RangeError);
    expect(() => percentileSorted([1], 101)).toThrow(RangeError);
    expect(() => percentileSorted([1], Number.NaN)).toThrow(RangeError);
  });
});

describe("summarize", () => {
  it("sorts a copy and reports count, percentiles, extremes and mean", () => {
    const values = [5, 1, 4, 2, 3];
    const summary = summarize(values);
    expect(values).toEqual([5, 1, 4, 2, 3]);
    expect(summary).toEqual({
      count: 5,
      missing: 0,
      min: 1,
      p50: 3,
      p95: 5,
      p99: 5,
      max: 5,
      mean: 3,
    });
  });

  it("counts missing deliveries as infinitely late", () => {
    // 19 observed + 1 missing: p95 is the 19th of 20, still observed.
    const nineteen = Array.from({ length: 19 }, (_, i) => i + 1);
    expect(summarize(nineteen, 1)).toMatchObject({ count: 19, missing: 1, p95: 19, max: Infinity });
    // 18 observed + 2 missing: more than 5% missing, so p95 is Infinity.
    const eighteen = Array.from({ length: 18 }, (_, i) => i + 1);
    expect(summarize(eighteen, 2)).toMatchObject({ p50: 10, p95: Infinity });
  });

  it("keeps the mean to observed samples", () => {
    expect(summarize([2, 4], 3).mean).toBe(3);
  });

  it("has no values, only counts, when there are no samples", () => {
    expect(summarize([])).toEqual({
      count: 0,
      missing: 0,
      min: null,
      p50: null,
      p95: null,
      p99: null,
      max: null,
      mean: null,
    });
  });

  it("refuses non-finite samples and bad missing counts", () => {
    expect(() => summarize([1, Number.NaN])).toThrow(/not finite/);
    expect(() => summarize([1, Infinity])).toThrow(/not finite/);
    expect(() => summarize([1], -1)).toThrow(RangeError);
    expect(() => summarize([1], 0.5)).toThrow(RangeError);
  });

  it("sorts numerically, not as strings", () => {
    expect(summarize([10, 9, 100]).min).toBe(9);
    expect(summarize([10, 9, 100]).p50).toBe(10);
  });
});
