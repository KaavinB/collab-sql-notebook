import { describe, expect, it } from "vitest";

import { estimateOffset, nowUs } from "../src/clock.ts";
import { pairKeystrokes } from "../src/keystrokes.ts";

describe("estimateOffset", () => {
  it("uses the probe with the shortest round trip, assuming the midpoint", () => {
    const offset = estimateOffset([
      { before: 0, remote: 120, after: 10 }, // round trip 10
      { before: 100, remote: 203, after: 102 }, // round trip 2: offset 203 - 101 = 102
      { before: 200, remote: 400, after: 260 },
    ]);
    expect(offset).toEqual({ offsetMs: 102, uncertaintyMs: 1, probes: 3 });
  });

  it("ignores probes that went backwards and needs at least one usable", () => {
    expect(
      estimateOffset([
        { before: 5, remote: 0, after: 4 },
        { before: 0, remote: 1, after: 2 },
      ]),
    ).toMatchObject({ offsetMs: 0 });
    expect(() => estimateOffset([])).toThrow(/no usable/);
  });
});

describe("nowUs", () => {
  it("is a monotonic integer count of microseconds", () => {
    const a = nowUs();
    const b = nowUs();
    expect(Number.isSafeInteger(a)).toBe(true);
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe("pairKeystrokes", () => {
  const base = {
    baseLength: 3, // the watcher's text was 3 characters before typing
    warmup: 1,
    typistOffsetMs: 0,
    watcherOffsetMs: 0,
  };

  it("matches keystroke i to the moment the text reached baseLength + i + 1", () => {
    const pairing = pairKeystrokes({
      ...base,
      keydownMs: [1000, 1200, 1400],
      appearedAt: [
        [4, 1010],
        [5, 1215],
        [6, 1420],
      ],
    });
    expect(pairing.warmup).toBe(1);
    expect(pairing.measuredMs).toEqual([15, 20]);
    expect(pairing.missing).toBe(0);
    expect(pairing.samples[0]).toMatchObject({ phase: "warmup", latencyMs: 10 });
  });

  it("gives keystrokes that arrived together the same appearance time", () => {
    const pairing = pairKeystrokes({
      ...base,
      warmup: 0,
      keydownMs: [1000, 1200],
      appearedAt: [
        [4, 1300],
        [5, 1300],
      ],
    });
    expect(pairing.measuredMs).toEqual([300, 100]);
  });

  it("counts a keystroke that never appeared as missing", () => {
    const pairing = pairKeystrokes({
      ...base,
      keydownMs: [1000, 1200, 1400],
      appearedAt: [[4, 1010]],
    });
    expect(pairing.missing).toBe(2);
    expect(pairing.measuredMs).toEqual([]);
    expect(pairing.samples[2]!.latencyMs).toBeNull();
  });

  it("removes each page's clock offset", () => {
    // The watcher's clock runs 50 ms ahead of the reference, the typist's 10 ms behind.
    const pairing = pairKeystrokes({
      ...base,
      warmup: 0,
      typistOffsetMs: -10,
      watcherOffsetMs: 50,
      keydownMs: [990],
      appearedAt: [[4, 1070]],
    });
    // True times: keydown 1000, appeared 1020.
    expect(pairing.measuredMs).toEqual([20]);
  });

  it("keeps the earliest time if a length is reported twice", () => {
    const pairing = pairKeystrokes({
      ...base,
      warmup: 0,
      keydownMs: [1000],
      appearedAt: [
        [4, 1050],
        [4, 1030],
      ],
    });
    expect(pairing.measuredMs).toEqual([30]);
  });
});
