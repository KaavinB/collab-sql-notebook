/**
 * Turning step and scenario records into verdicts, the limit and report.md.
 * Pure functions, so the wording and the rules are unit-tested.
 */
import type { GitState, Machine } from "./provenance.ts";
import { percentileSorted, type Summary } from "./stats.ts";

/**
 * A worker's event loop running this late, or keystrokes going out this
 * late, means the load generator itself adds latency of that order: receipts
 * are timestamped when an observer thread gets to them, and a busy thread
 * flushes its sockets late. At or past it, a step is flagged.
 */
export const GENERATOR_DELAY_WARN_MS = 10;
/** Editors typing slower than this share of the asked rate means the step offered less load than it claims. */
export const MIN_RATE_FRACTION = 0.95;

export interface Provenance {
  kind: "load" | "latency";
  runId: string;
  label: string | null;
  startedAt: string;
  finishedAt: string;
  machine: Machine;
  git: GitState;
  /**
   * Whether this run started its own servers or attached to running ones;
   * `started` is false if the stack never came up.
   */
  stack: { attached: boolean; database: string | null; started: boolean };
  percentileMethod: string;
  clock: string;
}

/** How the load generator (this process's worker threads) kept up. */
export interface GeneratorHealth {
  /** This process's CPU (all threads) over the measured window, % of one core. */
  cpuPercentOfOneCore: number | null;
  /** Event-loop delay p99 of the most delayed observer thread, ms. */
  observerLoopDelayP99Ms: number | null;
  /** Event-loop delay p99 of the most delayed busy (non-observer) thread, ms. */
  busyLoopDelayP99Ms: number | null;
  /** How late measured keystrokes went out versus their schedule, ms. */
  sendLagP95Ms: number | null;
  sendLagMaxMs: number | null;
  targetRatePerClient: number;
  /** Measured keystrokes sent per editor per second. */
  achievedRatePerClient: number | null;
  /** The editors typed noticeably slower than asked, so the load was lower than claimed. */
  underDelivered: boolean;
  /** Any reason below; the latencies may include the generator's own delay. */
  limited: boolean;
  reasons: string[];
}

export interface GeneratorInput {
  cpuPercentOfOneCore: number | null;
  observerLoopP99Ms: readonly number[];
  busyLoopP99Ms: readonly number[];
  sendLagMs: ArrayLike<number>;
  targetRatePerClient: number;
  measuredSends: number;
  clients: number;
  measuredSeconds: number;
}

const maxOrNull = (values: readonly number[]) => (values.length ? Math.max(...values) : null);

export function assessGenerator(input: GeneratorInput): GeneratorHealth {
  const lag = Float64Array.from(input.sendLagMs).sort();
  const observerLoop = maxOrNull(input.observerLoopP99Ms);
  const busyLoop = maxOrNull(input.busyLoopP99Ms);
  const lagP95 = percentileSorted(lag, 95);
  const achieved =
    input.clients > 0 && input.measuredSeconds > 0
      ? input.measuredSends / (input.clients * input.measuredSeconds)
      : null;
  const reasons: string[] = [];
  const late = (value: number | null) => value !== null && value >= GENERATOR_DELAY_WARN_MS;
  if (late(observerLoop)) reasons.push(`observer threads ran ${fmt(observerLoop)} ms late (p99)`);
  if (late(busyLoop)) reasons.push(`editor threads ran ${fmt(busyLoop)} ms late (p99)`);
  if (late(lagP95)) reasons.push(`keystrokes went out ${fmt(lagP95)} ms late (p95)`);
  const underDelivered =
    achieved !== null && achieved < MIN_RATE_FRACTION * input.targetRatePerClient;
  if (underDelivered) {
    reasons.push(
      `editors typed ${fmt(achieved, 2)}/s of the ${fmt(input.targetRatePerClient, 2)}/s asked`,
    );
  }
  return {
    cpuPercentOfOneCore: input.cpuPercentOfOneCore,
    observerLoopDelayP99Ms: observerLoop,
    busyLoopDelayP99Ms: busyLoop,
    sendLagP95Ms: lagP95,
    sendLagMaxMs: lag.length ? lag[lag.length - 1]! : null,
    targetRatePerClient: input.targetRatePerClient,
    achievedRatePerClient: achieved,
    underDelivered,
    limited: reasons.length > 0,
    reasons,
  };
}

/**
 * pass: p95 under the threshold at the load asked for.
 * fail: p95 at or over it (or too many deliveries missing), with the generator keeping up.
 * inconclusive: the generator didn't keep up, so a slow result may be its own,
 *   or a fast one came from less load than asked.
 * error: the step didn't complete.
 */
export type Verdict = "pass" | "fail" | "inconclusive" | "error";

export function judgeStep(
  latency: Summary,
  thresholdMs: number,
  generator: Pick<GeneratorHealth, "limited" | "underDelivered">,
): { verdict: Verdict; failure: string | null } {
  let slow: string | null = null;
  if (latency.count + latency.missing === 0) slow = "no samples";
  else if (latency.p95 === null || latency.p95 === Infinity) {
    slow = "more than 5% of deliveries missing";
  } else if (latency.p95 >= thresholdMs) {
    slow = `p95 ${fmt(latency.p95)} ms ≥ ${thresholdMs} ms`;
  }
  if (slow) {
    return generator.limited
      ? { verdict: "inconclusive", failure: `${slow}, but the load generator ran late` }
      : { verdict: "fail", failure: slow };
  }
  // The generator's own delay only adds latency, so a fast result stands,
  // unless the load offered was lower than asked.
  if (generator.underDelivered) {
    return { verdict: "inconclusive", failure: "the editors typed slower than asked" };
  }
  return { verdict: "pass", failure: null };
}

export interface Limit {
  /** Clients in the last step of the leading run of passing steps; null if the first step didn't pass. */
  limit: number | null;
  /** The first step that didn't pass, which ended the leading run; null if all passed. */
  stop: { clients: number; verdict: Verdict; failure: string | null } | null;
  /**
   * found: a step failed with the generator keeping up, so `limit` is the limit.
   * open-ended: every step passed; the limit is at least `limit`.
   * inconclusive: the run ended at a step the generator couldn't drive, or that errored.
   */
  kind: "found" | "open-ended" | "inconclusive";
  /** Steps after the stop that passed anyway (noise, worth a rerun). */
  passedAfterStop: number[];
}

type StepVerdict = { clients: number; verdict: Verdict; failure: string | null };

/** The limit: the last step whose p95 stays under the threshold, counting from the first step. */
export function findLimit(steps: ReadonlyArray<StepVerdict>): Limit {
  let limit: number | null = null;
  let stop: Limit["stop"] = null;
  const passedAfterStop: number[] = [];
  for (const step of steps) {
    if (stop === null) {
      if (step.verdict === "pass") limit = step.clients;
      else stop = { clients: step.clients, verdict: step.verdict, failure: step.failure };
    } else if (step.verdict === "pass") {
      passedAfterStop.push(step.clients);
    }
  }
  const kind = stop === null ? "open-ended" : stop.verdict === "fail" ? "found" : "inconclusive";
  return { limit, stop, kind, passedAfterStop };
}

/** The headline sentence for a limit. Never states a number as the limit unless it was found. */
export function limitHeadline(l: Limit, thresholdMs: number): string {
  if (l.kind === "open-ended" && l.limit === null) {
    return "**Limit:** not measured: no step ran.";
  }
  if (l.kind === "open-ended") {
    return (
      `**Limit:** at least ${l.limit} concurrent editors (every step tried kept p95 under ` +
      `${thresholdMs} ms; larger steps weren't run).`
    );
  }
  const stop = l.stop!;
  if (l.kind === "found") {
    return l.limit === null
      ? `**Limit:** none: the first step (${stop.clients} editors) already missed p95 < ` +
          `${thresholdMs} ms (${stop.failure}).`
      : `**Limit:** ${l.limit} concurrent editors: the last step whose p95 stayed under ` +
          `${thresholdMs} ms (${stop.clients} editors did not: ${stop.failure}). The load ` +
          `generator runs on the same machine as the servers, so compare the Generator CPU % ` +
          `and Sync CPU % columns before reading this as the server's limit alone.`;
  }
  const atLeast = l.limit === null ? "not established" : `at least ${l.limit} concurrent editors`;
  const why =
    stop.verdict === "error"
      ? `the step with ${stop.clients} editors didn't complete (${stop.failure})`
      : `the load generator saturated at ${stop.clients} editors (${stop.failure})`;
  return `**Limit:** inconclusive: ${atLeast}; ${why}.`;
}

/** Milliseconds for a table cell. */
export function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return "–";
  if (value === Infinity) return "∞";
  return value.toFixed(digits);
}

function machineLines(p: Provenance): string[] {
  const m = p.machine;
  const checkout =
    `${p.git.commit ?? "unknown commit"}` +
    (p.git.dirty === null
      ? ""
      : p.git.dirty
        ? ` with uncommitted changes (${p.git.changedPaths} paths)`
        : " (clean)");
  return [
    `- **Machine:** ${m.cpuModel}, ${m.logicalCpus} logical CPUs, ` +
      `${(m.memoryBytes / 2 ** 30).toFixed(1)} GiB RAM, ${m.os} ${m.osRelease} (${m.arch}), ` +
      `Node ${m.node}. Load average at start: ${m.loadAverageAtStart.join(", ")}.`,
    p.stack.attached
      ? `- **Code:** server code unknown (attached to servers already running on the bench ` +
        `ports); benchmark scripts from ${checkout}.`
      : `- **Code:** ${checkout}.`,
    `- **Run:** ${p.runId}${p.label ? ` ("${p.label}")` : ""}, ${p.startedAt} to ${p.finishedAt}.`,
    `- **Stack:** ${
      !p.stack.started
        ? "didn't come up (see the logs in this directory)"
        : p.stack.attached
          ? "attached to servers already running on the bench ports"
          : `started by this run (database ${p.stack.database})`
    }.`,
    `- **Statistics:** ${p.percentileMethod}`,
    `- **Clock:** ${p.clock}`,
  ];
}

export interface Traffic {
  inboundMessagesPerSecond: number;
  outboundMessagesPerSecond: number;
  inboundBytesPerSecond: number;
  outboundBytesPerSecond: number;
  meanInboundMessageBytes: number | null;
  meanOutboundMessageBytes: number | null;
}

export interface Deliveries {
  expected: number;
  measured: number;
  missing: number;
  warmupExcluded: number;
  duplicates: number;
  unknown: number;
  outside: number;
}

export interface LoadStep {
  clients: number;
  observers: number;
  /** Set when the step didn't complete; the other measurements are then empty. */
  error: string | null;
  latencyMs: Summary;
  deliveries: Deliveries;
  sends: { measured: number; warmup: number };
  drain: { complete: boolean; waitedMs: number } | null;
  traffic: Traffic | null;
  syncServer: { cpuPercentOfOneCore: number; rssPeakMb: number; rssEndMb: number } | null;
  generator: GeneratorHealth | null;
  unexpectedCloses: number;
  verdict: Verdict;
  /** Why the step didn't pass; null if it passed. */
  failure: string | null;
}

export const NO_DELIVERIES: Deliveries = {
  expected: 0,
  measured: 0,
  missing: 0,
  warmupExcluded: 0,
  duplicates: 0,
  unknown: 0,
  outside: 0,
};

/** The record of a step that threw before it could be measured. */
export function erroredStep(clients: number, empty: Summary, message: string): LoadStep {
  return {
    clients,
    observers: 0,
    error: message,
    latencyMs: empty,
    deliveries: NO_DELIVERIES,
    sends: { measured: 0, warmup: 0 },
    drain: null,
    traffic: null,
    syncServer: null,
    generator: null,
    unexpectedCloses: 0,
    verdict: "error",
    failure: `error: ${message}`,
  };
}

export interface LoadSummary {
  provenance: Provenance;
  parameters: Record<string, unknown>;
  thresholdMs: number;
  steps: LoadStep[];
  limit: Limit;
  /** Set when the run stopped outside any step (e.g. signing in failed). */
  aborted: string | null;
}

const STAMP_NOTE =
  "Each simulated keystroke inserts a stamp (`sender:seq:send-time;`, about 20 characters) " +
  "rather than one character, so the receiver can compute the latency from the edit itself; " +
  "edit messages are therefore somewhat larger than a real keystroke's. The mean message " +
  "sizes above are as measured.";

function verdictCell(verdict: Verdict, failure: string | null): string {
  return verdict === "pass" ? "pass" : `${verdict} (${failure})`;
}

export function renderLoadReport(s: LoadSummary): string {
  const lines: string[] = [];
  lines.push(`# Load test: ${s.provenance.runId}`, "");
  lines.push(
    "Edit-to-remote-apply latency between headless Node Yjs clients (y-websocket over real " +
      "WebSockets, real tickets) in one notebook, all typing at once. Measured from the moment a " +
      "client makes an edit to the moment another client's Y.Doc has applied it. These clients " +
      "are not browsers: no rendering is included (the browser benchmark measures that).",
    "",
  );
  lines.push(...machineLines(s.provenance));
  lines.push(`- **Parameters:** \`${JSON.stringify(s.parameters)}\``, "");
  if (s.aborted) lines.push(`**The run stopped early:** ${s.aborted}`, "");

  lines.push(limitHeadline(s.limit, s.thresholdMs));
  if (s.limit.passedAfterStop.length) {
    lines.push(
      "",
      `Note: ${s.limit.passedAfterStop.join(", ")} editors passed after an earlier step didn't; ` +
        "the result is noisy and worth rerunning.",
    );
  }
  const limited = s.steps.filter((step) => step.generator?.limited);
  if (limited.length) {
    lines.push("", "Warning: the load generator itself didn't keep up at:");
    for (const step of limited) {
      lines.push(`- ${step.clients} editors: ${step.generator!.reasons.join("; ")}`);
    }
    lines.push(
      "",
      "Its own delay adds to the latencies measured there, so a slow result at those steps " +
        "can't be blamed on the server. A machine with more cores (or more --workers / " +
        "--observer-workers) would separate the two.",
    );
  }
  const errored = s.steps.filter((step) => step.error);
  for (const step of errored) lines.push("", `Error at ${step.clients} editors: ${step.error}`);

  lines.push(
    "",
    "## Latency per step",
    "",
    "| Editors | Samples | Warm-up excl. | Missing | p50 ms | p95 ms | p99 ms | max ms | " +
      "Msgs/s in | Msgs/s out | Sync CPU % | Sync RSS MB | Result |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  );
  for (const step of s.steps) {
    const sync = step.syncServer;
    lines.push(
      `| ${[
        step.clients,
        step.latencyMs.count,
        step.deliveries.warmupExcluded,
        step.deliveries.missing,
        fmt(step.latencyMs.p50),
        fmt(step.latencyMs.p95),
        fmt(step.latencyMs.p99),
        fmt(step.latencyMs.max),
        fmt(step.traffic?.inboundMessagesPerSecond, 0),
        fmt(step.traffic?.outboundMessagesPerSecond, 0),
        sync ? fmt(sync.cpuPercentOfOneCore, 0) : "not measured",
        sync ? `${fmt(sync.rssPeakMb, 0)} peak` : "not measured",
        verdictCell(step.verdict, step.failure),
      ].join(" | ")} |`,
    );
  }
  lines.push(
    "",
    "## Bookkeeping and load generator",
    "",
    "| Editors | Observers | Expected | Measured | Missing | Duplicates | Unknown | Outside window | " +
      "Drain | Unexpected closes | Keystrokes/s per editor (asked) | Bytes/msg in | Bytes/msg out | " +
      "Observer loop p99 ms | Editor loop p99 ms | Send lag p95 ms | Generator CPU % |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const step of s.steps) {
    const d = step.deliveries;
    const g = step.generator;
    lines.push(
      `| ${[
        step.clients,
        step.observers,
        d.expected,
        d.measured,
        d.missing,
        d.duplicates,
        d.unknown,
        d.outside,
        step.drain
          ? `${step.drain.complete ? "complete" : "INCOMPLETE"} (${fmt(step.drain.waitedMs, 0)} ms)`
          : "–",
        step.unexpectedCloses,
        g ? `${fmt(g.achievedRatePerClient, 2)} (${fmt(g.targetRatePerClient, 2)})` : "–",
        fmt(step.traffic?.meanInboundMessageBytes, 0),
        fmt(step.traffic?.meanOutboundMessageBytes, 0),
        fmt(g?.observerLoopDelayP99Ms),
        fmt(g?.busyLoopDelayP99Ms),
        fmt(g?.sendLagP95Ms),
        fmt(g?.cpuPercentOfOneCore, 0),
      ].join(" | ")} |`,
    );
  }
  lines.push(
    "",
    "Samples are measured deliveries (one per edit per observing editor); missing deliveries " +
      "count as infinitely late in the percentiles. Expected = every observer receiving every " +
      "other editor's measured edit; samples.jsonl holds every send and receipt, so this can be " +
      "recounted. Duplicates and unknown receipts (matching no logged send) are excluded and " +
      "should be 0. Observers run on worker threads of their own, so the editors' work can't " +
      "delay their timestamps. Messages per second are counted at the clients' sockets over the " +
      "measured window: in = sent to the sync server, out = sent by it. In includes " +
      "y-websocket's provider re-sending every presence (cursor) change it receives, which the " +
      "browser's provider does too, so it grows with the square of the editors. Sync CPU is the " +
      "server process's CPU time over the measured window as a percentage of one core.",
    "",
    STAMP_NOTE,
    "",
  );
  return lines.join("\n");
}

export interface LatencyLoad {
  clients: number;
  /** The load's measured window covered the whole browser typing run. */
  coveredTyping: boolean;
  drain: { complete: boolean; waitedMs: number };
  deliveries: Deliveries;
  unexpectedCloses: number;
  traffic: Traffic;
  generator: GeneratorHealth;
  /** The Node clients' own edit-to-apply latency during the scenario. */
  nodeLatencyMs: Summary;
}

export interface LatencyScenario {
  loadClients: number;
  /** Set when the scenario didn't complete; the measurements are then empty. */
  error: string | null;
  keystrokes: { measured: number; warmupExcluded: number; missing: number };
  /** Keystrokes per second the browser actually typed (first to last keydown), and asked for. */
  typingRate: { achievedPerSecond: number | null; targetPerSecond: number };
  latencyMs: Summary;
  clocks: {
    typistOffsetMs: number;
    watcherOffsetMs: number;
    /** Bound on the error left after the correction. */
    uncertaintyMs: number;
    /** How much the offset difference moved between the probes before and after typing. */
    driftMs: number;
  } | null;
  /** Each page's cell text equals exactly what was typed. */
  textMatches: { typist: boolean; watcher: boolean } | null;
  load: LatencyLoad | null;
}

export interface LatencySummary {
  provenance: Provenance;
  parameters: Record<string, unknown>;
  browser: string;
  scenarios: LatencyScenario[];
  aborted: string | null;
}

export function renderLatencyReport(s: LatencySummary): string {
  const lines: string[] = [];
  lines.push(`# Sync latency (browsers): ${s.provenance.runId}`, "");
  lines.push(
    "Keystroke-to-remote-render time between two real browsers (Playwright, " +
      `${s.browser}, headless, one machine). One page types into a sql cell; the other page's ` +
      "DOM is watched for the character. Timed from the keydown event on the typing page to the " +
      "first DOM mutation showing the character on the watching page: the whole path through " +
      "CodeMirror, y-codemirror, the WebSocket provider, the sync server and the other page's " +
      "CodeMirror. Not included: the paint after the DOM change, and real network distance (both " +
      'browsers and the server share one machine). "Load clients" are extra headless Node Yjs ' +
      "clients in the same notebook, each typing in its own cell until the browser has " +
      "finished; they are not browsers.",
    "",
  );
  lines.push(...machineLines(s.provenance));
  lines.push(`- **Parameters:** \`${JSON.stringify(s.parameters)}\``, "");
  if (s.aborted) lines.push(`**The run stopped early:** ${s.aborted}`, "");
  lines.push(
    "| Load clients | Keystrokes | Warm-up excl. | Missing | p50 ms | p95 ms | p99 ms | max ms | " +
      "Typed/s (asked) | Clock correction ms | ± ms | Text as typed |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  );
  for (const sc of s.scenarios) {
    lines.push(
      `| ${[
        sc.loadClients,
        sc.keystrokes.measured,
        sc.keystrokes.warmupExcluded,
        sc.keystrokes.missing,
        fmt(sc.latencyMs.p50),
        fmt(sc.latencyMs.p95),
        fmt(sc.latencyMs.p99),
        fmt(sc.latencyMs.max),
        `${fmt(sc.typingRate.achievedPerSecond, 2)} (${fmt(sc.typingRate.targetPerSecond, 2)})`,
        sc.clocks ? fmt(sc.clocks.watcherOffsetMs - sc.clocks.typistOffsetMs, 2) : "–",
        sc.clocks ? fmt(sc.clocks.uncertaintyMs, 2) : "–",
        sc.error
          ? `error: ${sc.error}`
          : sc.textMatches
            ? sc.textMatches.typist && sc.textMatches.watcher
              ? "yes, both pages"
              : `NO (typist ${sc.textMatches.typist ? "ok" : "differs"}, ` +
                `watcher ${sc.textMatches.watcher ? "ok" : "differs"})`
            : "–",
      ].join(" | ")} |`,
    );
  }
  const loaded = s.scenarios.filter((sc) => sc.load);
  if (loaded.length) {
    lines.push(
      "",
      "## Load clients",
      "",
      "| Load clients | Covered the typing | Node p50 ms | Node p95 ms | Node samples | Missing | " +
        "Duplicates | Unknown | Drain | Unexpected closes | Keystrokes/s per client (asked) | " +
        "Bytes/msg in | Bytes/msg out | Observer loop p99 ms | Client loop p99 ms | " +
        "Send lag p95 ms | Generator CPU % |",
      "|---:|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const sc of loaded) {
      const load = sc.load!;
      const g = load.generator;
      lines.push(
        `| ${[
          load.clients,
          load.coveredTyping ? "yes" : "NO",
          fmt(load.nodeLatencyMs.p50),
          fmt(load.nodeLatencyMs.p95),
          load.nodeLatencyMs.count,
          load.deliveries.missing,
          load.deliveries.duplicates,
          load.deliveries.unknown,
          `${load.drain.complete ? "complete" : "INCOMPLETE"} (${fmt(load.drain.waitedMs, 0)} ms)`,
          load.unexpectedCloses,
          `${fmt(g.achievedRatePerClient, 2)} (${fmt(g.targetRatePerClient, 2)})`,
          fmt(load.traffic.meanInboundMessageBytes, 0),
          fmt(load.traffic.meanOutboundMessageBytes, 0),
          fmt(g.observerLoopDelayP99Ms),
          fmt(g.busyLoopDelayP99Ms),
          fmt(g.sendLagP95Ms),
          fmt(g.cpuPercentOfOneCore, 0),
        ].join(" | ")} |`,
      );
    }
    for (const sc of loaded) {
      const g = sc.load!.generator;
      if (g.limited) {
        lines.push(
          "",
          `Warning: with ${sc.loadClients} load clients the load generator didn't keep up ` +
            `(${g.reasons.join("; ")}). ` +
            (g.underDelivered
              ? "The load on the browsers was lower than asked."
              : "The Node clients' own latencies include the generator's delay."),
        );
      }
    }
    lines.push("", STAMP_NOTE);
  }
  lines.push(
    "",
    "Clock correction: each page's clock (performance.timeOrigin + performance.now()) was " +
      "compared with this process's by round trips before and after typing; the difference " +
      "between the two pages' offsets was subtracted from every sample, and ± bounds what remains.",
    "",
  );
  return lines.join("\n");
}
