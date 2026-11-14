/**
 * Pairs the typist's keystrokes with the moments they appeared in the other
 * browser, for the browser latency benchmark.
 *
 * The typist's page records the time of every keydown. The watching page
 * records, for each length its copy of the cell's text reaches, the first
 * moment its DOM showed that length. Only the typist edits that cell, so
 * keystroke i (counting from 0) is the one that brings the text to
 * baseLength + i + 1. If two keystrokes arrive together, both lengths get
 * the same time, which is right: neither was visible earlier.
 */

export interface KeystrokeSample {
  index: number;
  phase: "warmup" | "measured";
  /** Keydown on the typist's page, typist's clock (ms since epoch). */
  keydownMs: number;
  /** First DOM appearance on the watcher's page, watcher's clock (ms since epoch); null if never. */
  appearedMs: number | null;
  /** appeared - keydown after removing both pages' measured clock offsets; null if never appeared. */
  latencyMs: number | null;
}

export interface PairingInput {
  keydownMs: readonly number[];
  /** [length, ms]: the first time the watcher's text reached each length. */
  appearedAt: ReadonlyArray<readonly [number, number]>;
  baseLength: number;
  warmup: number;
  /** Each page's clock minus the reference clock (ms), as estimated by round trips. */
  typistOffsetMs: number;
  watcherOffsetMs: number;
}

export interface Pairing {
  samples: KeystrokeSample[];
  measuredMs: number[];
  warmup: number;
  missing: number;
}

export function pairKeystrokes(input: PairingInput): Pairing {
  const appeared = new Map<number, number>();
  for (const [length, ms] of input.appearedAt) {
    // Keep the earliest time for a length, whatever order they came in.
    const previous = appeared.get(length);
    if (previous === undefined || ms < previous) appeared.set(length, ms);
  }
  const samples: KeystrokeSample[] = [];
  const measuredMs: number[] = [];
  let missing = 0;
  let warmup = 0;
  input.keydownMs.forEach((keydownMs, index) => {
    const phase = index < input.warmup ? "warmup" : "measured";
    const appearedMs = appeared.get(input.baseLength + index + 1) ?? null;
    const latencyMs =
      appearedMs === null
        ? null
        : appearedMs - input.watcherOffsetMs - (keydownMs - input.typistOffsetMs);
    samples.push({ index, phase, keydownMs, appearedMs, latencyMs });
    if (phase === "warmup") warmup++;
    else if (latencyMs === null) missing++;
    else measuredMs.push(latencyMs);
  });
  return { samples, measuredMs, warmup, missing };
}
