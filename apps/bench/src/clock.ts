/**
 * Clocks.
 *
 * Node clients: `process.hrtime` reads the operating system's monotonic
 * clock (CLOCK_MONOTONIC on Linux, mach_absolute_time on macOS), which is one
 * clock for the whole machine. A send time taken in one worker thread and a
 * receive time taken in another are therefore directly comparable, with no
 * skew and unaffected by NTP adjusting the wall clock mid-run.
 *
 * Browsers: each page reports `performance.timeOrigin + performance.now()`
 * (milliseconds since the Unix epoch, sub-millisecond precision). Each
 * browser process derives that from its own reading of the wall clock, so
 * two pages can disagree slightly. The latency benchmark measures each
 * page's offset from this process's clock (same formula) by round trips,
 * NTP-style, and corrects for it; see `estimateOffset`.
 */

/** Microseconds on the machine-wide monotonic clock (integer). */
export function nowUs(): number {
  return Number(process.hrtime.bigint() / 1000n);
}

/** Milliseconds since the epoch, the way browser pages report time. */
export function epochMs(): number {
  return performance.timeOrigin + performance.now();
}

export interface ClockProbe {
  /** This process's clock just before asking (ms). */
  before: number;
  /** The page's clock, read during the round trip (ms). */
  remote: number;
  /** This process's clock just after the answer (ms). */
  after: number;
}

export interface Offset {
  /** remote clock minus local clock, ms. */
  offsetMs: number;
  /** Half the round trip of the probe used: the offset is right to within ± this. */
  uncertaintyMs: number;
  /** Probes taken. */
  probes: number;
}

/**
 * The offset of a remote clock from ours, from round-trip probes. The page
 * read its clock somewhere between `before` and `after`, so assuming the
 * midpoint is wrong by at most half the round trip; the probe with the
 * shortest round trip gives the tightest bound, and is the one used.
 */
export function estimateOffset(probes: readonly ClockProbe[]): Offset {
  let best: ClockProbe | null = null;
  for (const probe of probes) {
    if (!(probe.after >= probe.before)) continue;
    if (!best || probe.after - probe.before < best.after - best.before) best = probe;
  }
  if (!best) throw new Error("no usable clock probe");
  return {
    offsetMs: best.remote - (best.before + best.after) / 2,
    uncertaintyMs: (best.after - best.before) / 2,
    probes: probes.length,
  };
}
