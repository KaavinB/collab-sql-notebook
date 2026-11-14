import { describe, expect, it } from "vitest";

import { parseLabel, parseNumber, parseSteps, UsageError } from "../src/args.ts";
import { layoutWorkers, seededRandom } from "../src/fleet.ts";
import { runId } from "../src/provenance.ts";
import {
  assessGenerator,
  erroredStep,
  findLimit,
  fmt,
  judgeStep,
  limitHeadline,
  renderLatencyReport,
  renderLoadReport,
  type GeneratorHealth,
  type LatencyScenario,
  type LoadStep,
  type LoadSummary,
  type Provenance,
  type Verdict,
} from "../src/report.ts";
import { toJson } from "../src/results.ts";
import { benchDatabaseUrl } from "../src/stack.ts";
import { summarize } from "../src/stats.ts";

const keptUp = { limited: false, underDelivered: false };

describe("judgeStep", () => {
  it("passes only when p95 is strictly under the threshold", () => {
    expect(judgeStep(summarize([10, 20, 99]), 100, keptUp)).toEqual({
      verdict: "pass",
      failure: null,
    });
    expect(judgeStep(summarize([10, 20, 100]), 100, keptUp).verdict).toBe("fail");
  });

  it("fails a step with no samples, or too many missing deliveries", () => {
    expect(judgeStep(summarize([]), 100, keptUp)).toEqual({
      verdict: "fail",
      failure: "no samples",
    });
    expect(judgeStep(summarize([1, 1, 1], 1), 100, keptUp).failure).toMatch(/missing/);
  });

  it("calls a slow step inconclusive when the load generator ran late", () => {
    const judged = judgeStep(summarize([150, 160]), 100, { limited: true, underDelivered: false });
    expect(judged.verdict).toBe("inconclusive");
    expect(judged.failure).toMatch(/load generator ran late/);
  });

  it("keeps a fast step's pass when the generator was only late, not short of load", () => {
    expect(judgeStep(summarize([5]), 100, { limited: true, underDelivered: false }).verdict).toBe(
      "pass",
    );
    expect(judgeStep(summarize([5]), 100, { limited: true, underDelivered: true }).verdict).toBe(
      "inconclusive",
    );
  });
});

describe("assessGenerator", () => {
  const base = {
    cpuPercentOfOneCore: 50,
    observerLoopP99Ms: [1, 2],
    busyLoopP99Ms: [3],
    sendLagMs: [0.5, 1, 2],
    targetRatePerClient: 5,
    measuredSends: 100,
    clients: 2,
    measuredSeconds: 10,
  };

  it("passes a generator that kept up, and reports the achieved rate", () => {
    const health = assessGenerator(base);
    expect(health).toMatchObject({
      observerLoopDelayP99Ms: 2,
      busyLoopDelayP99Ms: 3,
      sendLagP95Ms: 2,
      achievedRatePerClient: 5,
      limited: false,
      underDelivered: false,
      reasons: [],
    });
  });

  it("names every way it fell behind", () => {
    const health = assessGenerator({
      ...base,
      observerLoopP99Ms: [12],
      busyLoopP99Ms: [30],
      sendLagMs: [15],
      measuredSends: 80, // 4/s of 5/s asked
    });
    expect(health.limited).toBe(true);
    expect(health.underDelivered).toBe(true);
    expect(health.reasons).toHaveLength(4);
    expect(health.reasons.join("; ")).toMatch(/observer threads ran 12\.0 ms late/);
  });
});

const step = (clients: number, verdict: Verdict, failure: string | null = null) => ({
  clients,
  verdict,
  failure,
});

describe("findLimit", () => {
  const steps = (...verdicts: Verdict[]) =>
    verdicts.map((verdict, i) => step([2, 5, 10, 25, 50][i]!, verdict, verdict));

  it("is the last step of the leading run of passes, found at a real failure", () => {
    expect(findLimit(steps("pass", "pass", "fail"))).toEqual({
      limit: 5,
      stop: { clients: 10, verdict: "fail", failure: "fail" },
      kind: "found",
      passedAfterStop: [],
    });
  });

  it("notes passes after the stop without moving the limit", () => {
    expect(findLimit(steps("pass", "fail", "pass", "fail"))).toMatchObject({
      limit: 2,
      passedAfterStop: [10],
    });
  });

  it("is open-ended when nothing failed", () => {
    expect(findLimit(steps("pass", "pass"))).toMatchObject({ limit: 5, kind: "open-ended" });
  });

  it("is inconclusive when the run ended at a generator-limited or errored step", () => {
    expect(findLimit(steps("pass", "inconclusive", "fail"))).toMatchObject({
      limit: 2,
      kind: "inconclusive",
      stop: { clients: 5, verdict: "inconclusive" },
    });
    expect(findLimit(steps("pass", "error"))).toMatchObject({ limit: 2, kind: "inconclusive" });
  });
});

describe("limitHeadline", () => {
  it("never states a number as the limit unless a real failure found it", () => {
    expect(limitHeadline(findLimit([step(2, "pass"), step(5, "fail", "p95 slow")]), 100)).toBe(
      "**Limit:** 2 concurrent editors: the last step whose p95 stayed under 100 ms " +
        "(5 editors did not: p95 slow). The load generator runs on the same machine as the servers, so compare the Generator CPU % and Sync CPU % columns before reading this as the server's limit alone.",
    );
    expect(
      limitHeadline(findLimit([step(2, "pass"), step(5, "inconclusive", "generator")]), 100),
    ).toBe(
      "**Limit:** inconclusive: at least 2 concurrent editors; the load generator saturated at " +
        "5 editors (generator).",
    );
    expect(limitHeadline(findLimit([step(2, "inconclusive", "x")]), 100)).toMatch(
      /^\*\*Limit:\*\* inconclusive: not established; the load generator saturated at 2/,
    );
    expect(limitHeadline(findLimit([step(2, "pass"), step(5, "error", "boom")]), 100)).toMatch(
      /inconclusive: at least 2 concurrent editors; the step with 5 editors didn't complete/,
    );
    expect(limitHeadline(findLimit([step(2, "fail", "slow")]), 100)).toMatch(
      /^\*\*Limit:\*\* none: the first step/,
    );
    expect(limitHeadline(findLimit([step(2, "pass")]), 100)).toMatch(/at least 2/);
    expect(limitHeadline(findLimit([]), 100)).toBe("**Limit:** not measured: no step ran.");
  });
});

describe("layoutWorkers", () => {
  it("gives observers threads of their own and spreads the rest", () => {
    expect(layoutWorkers(7, 3, 2, 2)).toEqual([
      { role: "observer", clients: [0, 2] },
      { role: "observer", clients: [1] },
      { role: "busy", clients: [3, 5] },
      { role: "busy", clients: [4, 6] },
    ]);
  });

  it("makes no empty threads", () => {
    expect(layoutWorkers(2, 8, 2, 4)).toEqual([
      { role: "observer", clients: [0] },
      { role: "observer", clients: [1] },
    ]);
    expect(layoutWorkers(1, 1, 3, 3)).toEqual([{ role: "observer", clients: [0] }]);
  });
});

const provenance = (attached = false): Provenance => ({
  kind: "load",
  runId: "load-20261113T000000Z-abcdef0",
  label: "smoke",
  startedAt: "2026-11-13T00:00:00.000Z",
  finishedAt: "2026-11-13T00:01:00.000Z",
  machine: {
    cpuModel: "Test CPU",
    logicalCpus: 8,
    availableParallelism: 8,
    memoryBytes: 16 * 2 ** 30,
    os: "Darwin",
    osRelease: "25.0.0",
    arch: "arm64",
    node: "v26.3.0",
    loadAverageAtStart: [1, 2, 3],
  },
  git: { commit: "abcdef0123", dirty: true, changedPaths: 3 },
  stack: { attached, database: attached ? null : "notebook_bench_test", started: true },
  percentileMethod: "nearest rank",
  clock: "hrtime",
});

const health = (limited = false): GeneratorHealth => ({
  cpuPercentOfOneCore: 50,
  observerLoopDelayP99Ms: limited ? 25 : 1,
  busyLoopDelayP99Ms: 1,
  sendLagP95Ms: 1,
  sendLagMaxMs: 2,
  targetRatePerClient: 5,
  achievedRatePerClient: 5,
  underDelivered: false,
  limited,
  reasons: limited ? ["observer threads ran 25.0 ms late (p99)"] : [],
});

describe("renderLoadReport", () => {
  const loadStep = (clients: number, verdict: Verdict, limited = false): LoadStep => ({
    clients,
    observers: Math.min(clients, 8),
    error: null,
    latencyMs: summarize([1, 2, 3]),
    deliveries: {
      expected: 3,
      measured: 3,
      missing: 0,
      warmupExcluded: 4,
      duplicates: 1,
      unknown: 2,
      outside: 0,
    },
    sends: { measured: 3, warmup: 2 },
    drain: { complete: false, waitedMs: 5 },
    traffic: {
      inboundMessagesPerSecond: 10,
      outboundMessagesPerSecond: 20,
      inboundBytesPerSecond: 1000,
      outboundBytesPerSecond: 2000,
      meanInboundMessageBytes: 100,
      meanOutboundMessageBytes: 77,
    },
    syncServer: null,
    generator: health(limited),
    unexpectedCloses: 6,
    verdict,
    failure: verdict === "pass" ? null : "p95 200.0 ms ≥ 100 ms",
  });
  const summary = (steps: LoadStep[], attached = false): LoadSummary => ({
    provenance: provenance(attached),
    parameters: { steps: [2, 5] },
    thresholdMs: 100,
    steps,
    limit: findLimit(steps),
    aborted: null,
  });

  it("states the limit, the machine, the code and every step", () => {
    const report = renderLoadReport(summary([loadStep(2, "pass"), loadStep(5, "fail")]));
    expect(report).toContain("**Limit:** 2 concurrent editors");
    expect(report).toContain("(5 editors did not: p95 200.0 ms ≥ 100 ms)");
    expect(report).toContain("Test CPU, 8 logical CPUs, 16.0 GiB RAM");
    expect(report).toContain("abcdef0123 with uncommitted changes (3 paths)");
    expect(report).toContain('("smoke")');
    expect(report).toMatch(/\| 2 \| 3 \| 4 \| 0 \| 2\.0 \| 3\.0 \|/);
    expect(report).toContain("not measured");
    expect(report).toContain("are not browsers");
  });

  it("shows the bookkeeping: duplicates, unknown, drain, closes, message sizes, the stamp", () => {
    const report = renderLoadReport(summary([loadStep(2, "pass")]));
    // editors, observers, expected, measured, missing, duplicates, unknown, outside, drain, closes
    expect(report).toMatch(
      /\| 2 \| 2 \| 3 \| 3 \| 0 \| 1 \| 2 \| 0 \| INCOMPLETE \(5 ms\) \| 6 \|/,
    );
    expect(report).toMatch(/\| 5\.00 \(5\.00\) \| 100 \| 77 \|/);
    expect(report).toContain("about 20 characters");
  });

  it("calls the limit inconclusive when the generator saturated, and says why", () => {
    const report = renderLoadReport(
      summary([loadStep(2, "pass"), loadStep(5, "inconclusive", true)]),
    );
    expect(report).toContain(
      "**Limit:** inconclusive: at least 2 concurrent editors; the load generator saturated at 5",
    );
    expect(report).not.toMatch(/\*\*Limit:\*\* 2 concurrent/);
    expect(report).toContain("- 5 editors: observer threads ran 25.0 ms late (p99)");
  });

  it("records a step that errored, and a run that stopped early", () => {
    const errored = erroredStep(5, summarize([]), "connect timeout");
    const s = { ...summary([loadStep(2, "pass"), errored]), aborted: "owner sign-in failed" };
    const report = renderLoadReport(s);
    expect(report).toContain("Error at 5 editors: connect timeout");
    expect(report).toContain("didn't complete (error: connect timeout)");
    expect(report).toContain("**The run stopped early:** owner sign-in failed");
  });

  it("doesn't claim the server's code when attached to running servers", () => {
    const report = renderLoadReport(summary([loadStep(2, "pass")], true));
    expect(report).toContain("server code unknown (attached");
    expect(report).toContain("benchmark scripts from abcdef0123");
  });
});

describe("renderLatencyReport", () => {
  const scenario = (load: boolean, matches = true): LatencyScenario => ({
    loadClients: load ? 3 : 0,
    error: null,
    keystrokes: { measured: 10, warmupExcluded: 2, missing: 0 },
    typingRate: { achievedPerSecond: 4.98, targetPerSecond: 5 },
    latencyMs: summarize([1, 2, 3]),
    clocks: { typistOffsetMs: 0.1, watcherOffsetMs: 0.3, uncertaintyMs: 0.5, driftMs: 0 },
    textMatches: { typist: true, watcher: matches },
    load: load
      ? {
          clients: 3,
          coveredTyping: false,
          drain: { complete: true, waitedMs: 1 },
          deliveries: {
            expected: 1,
            measured: 1,
            missing: 0,
            warmupExcluded: 0,
            duplicates: 0,
            unknown: 0,
            outside: 0,
          },
          unexpectedCloses: 0,
          traffic: {
            inboundMessagesPerSecond: 1,
            outboundMessagesPerSecond: 1,
            inboundBytesPerSecond: 1,
            outboundBytesPerSecond: 1,
            meanInboundMessageBytes: 211,
            meanOutboundMessageBytes: 199,
          },
          generator: health(true),
          nodeLatencyMs: summarize([4]),
        }
      : null,
  });

  it("reports the typing rate, text check, load coverage and the generator", () => {
    const report = renderLatencyReport({
      provenance: { ...provenance(), kind: "latency" },
      parameters: { loadWarmupSeconds: 3 },
      browser: "Chromium 1",
      scenarios: [scenario(false), scenario(true, false)],
      aborted: null,
    });
    expect(report).toContain("4.98 (5.00)");
    expect(report).toContain("yes, both pages");
    expect(report).toContain("NO (typist ok, watcher differs)");
    expect(report).toMatch(/\| 3 \| NO \| 4\.0 \|/);
    expect(report).toContain("with 3 load clients the load generator didn't keep up");
    expect(report).toContain("The Node clients' own latencies include the generator's delay.");
    expect(report).toMatch(/\| 211 \| 199 \|/);
    expect(report).toContain('"loadWarmupSeconds":3');
  });
});

describe("formatting and storage", () => {
  it("prints missing values and infinity distinctly", () => {
    expect(fmt(null)).toBe("–");
    expect(fmt(Infinity)).toBe("∞");
    expect(fmt(12.345)).toBe("12.3");
  });

  it("keeps Infinity in JSON instead of turning it into null", () => {
    expect(JSON.parse(toJson({ p95: Infinity, p50: 1 }))).toEqual({ p95: "Infinity", p50: 1 });
  });

  it("makes run IDs that sort by time and name the commit", () => {
    expect(runId("load", new Date("2026-11-13T10:15:00.123Z"), "a588d71ffff")).toBe(
      "load-20261113T101500Z-a588d71",
    );
    expect(runId("latency", new Date("2026-11-13T10:15:00Z"), null)).toMatch(/-nogit$/);
  });
});

describe("arguments", () => {
  it("parses increasing step lists", () => {
    expect(parseSteps("2, 5,10", "steps")).toEqual([2, 5, 10]);
    expect(parseSteps("0,20", "load-clients", { allowZero: true })).toEqual([0, 20]);
    expect(() => parseSteps("0,20", "steps")).toThrow(UsageError);
    expect(() => parseSteps("5,2", "steps")).toThrow(/increasing/);
    expect(() => parseSteps("2,2", "steps")).toThrow(/increasing/);
    expect(() => parseSteps("2,x", "steps")).toThrow(UsageError);
    expect(() => parseSteps("", "steps")).toThrow(UsageError);
  });

  it("bounds numbers and labels", () => {
    expect(parseNumber("5", "rate", 0.1, 50)).toBe(5);
    expect(() => parseNumber("0", "rate", 0.1, 50)).toThrow(UsageError);
    expect(() => parseNumber(" ", "rate", 0, 50)).toThrow(UsageError);
    expect(parseLabel(undefined)).toBeNull();
    expect(parseLabel("smoke run 1")).toBe("smoke run 1");
    expect(() => parseLabel("<script>")).toThrow(UsageError);
  });
});

describe("seededRandom", () => {
  it("replays the same sequence from the same seed", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(first.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seededRandom(43)()).not.toBe(first[0]);
  });
});

describe("benchDatabaseUrl", () => {
  const dev = "postgresql+psycopg://notebook:pw@127.0.0.1:5432/notebook";

  it("renames the dev database to notebook_bench_test", () => {
    expect(benchDatabaseUrl({ DATABASE_URL: dev })).toBe(
      "postgresql+psycopg://notebook:pw@127.0.0.1:5432/notebook_bench_test",
    );
  });

  it("takes an explicit URL, but only for a database named *_test", () => {
    const other = "postgresql+psycopg://notebook:pw@127.0.0.1:5432/other_test";
    expect(benchDatabaseUrl({ DATABASE_URL: dev, BENCH_DATABASE_URL: other })).toBe(other);
    expect(() => benchDatabaseUrl({ BENCH_DATABASE_URL: dev })).toThrow(/must end in _test/);
    expect(() => benchDatabaseUrl({})).toThrow(/DATABASE_URL/);
    expect(() => benchDatabaseUrl({ BENCH_DATABASE_URL: "mysql://u:p@h/x_test" })).toThrow(
      /postgresql/,
    );
  });

  it("derives a URL only for a database server on this machine", () => {
    expect(
      benchDatabaseUrl({ DATABASE_URL: "postgresql://u:p@localhost:5432/notebook" }),
    ).toContain("@localhost:5432/notebook_bench_test");
    expect(() =>
      benchDatabaseUrl({ DATABASE_URL: "postgresql://u:p@db.example.com:5432/notebook" }),
    ).toThrow(/isn't on this machine; set BENCH_DATABASE_URL/);
    // An explicit choice is respected.
    const remote = "postgresql://u:p@db.example.com:5432/bench_test";
    expect(benchDatabaseUrl({ BENCH_DATABASE_URL: remote })).toBe(remote);
  });
});
