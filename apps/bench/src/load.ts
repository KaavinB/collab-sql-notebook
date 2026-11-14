/**
 * Load test: how many people can edit one notebook at once before sync
 * latency degrades.
 *
 * WHAT IS MEASURED
 *   Edit-to-remote-apply latency: from the moment a client makes an edit
 *   (a keystroke into its own Y.Text) to the moment another client's Y.Doc
 *   has applied it, through the real sync server over real WebSockets.
 *   Editors ramp in steps (default 2, 5, 10, 25, 50, 100, 200), all in one
 *   new notebook per step, each typing at a human rate (default 5
 *   keystrokes/s, each followed by a cursor update, as an editor sends) in
 *   its own cell. Each step reports p50/p95/p99/max with sample counts, the
 *   messages per second through the server, and the sync server's CPU and
 *   memory. The limit is the last step whose p95 stays under 100 ms.
 *
 *   Timing: each edit carries its sender, sequence number and send time (a
 *   short stamp typed as the keystroke's text); receivers compute the
 *   latency on the machine-wide monotonic clock (all clients run on this
 *   machine), so there's no clock skew. Edits sent during the warm-up
 *   (default 5 s) are excluded and counted; deliveries that never arrive
 *   count as infinitely late.
 *
 * WHAT ISN'T
 *   The clients are headless Node Yjs clients (y-websocket over `ws`, real
 *   tickets from the API), not browsers: no CodeMirror, no DOM, no
 *   rendering. `pnpm bench:latency` measures the browser path. Everything
 *   runs on one machine, so there's no network distance, and the clients
 *   compete with the server for CPU. Only some editors record receipts
 *   (--observers, default 8), on worker threads of their own so the other
 *   editors' work can't delay their timestamps; every editor still receives
 *   and applies every update. When the load generator can't keep up (its
 *   threads run late, or editors type slower than asked), a slow step is
 *   reported as inconclusive rather than as the server's limit.
 *
 * HOW TO RERUN
 *   docker compose up -d     # Postgres
 *   pnpm bench:load          # starts its own API and sync server on 8200/8220
 *   pnpm bench:load --steps 2,5,10 --duration 10 --label "quick look"
 *   pnpm bench:load --help
 *   Results go to data/bench-results/<run-id>/ (samples.jsonl, summary.json,
 *   report.md), also when a step fails. Run it on a quiet machine: the
 *   numbers are only as good as the machine is idle, and the report records
 *   the load average at start.
 */
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { analyzeFleet, errorMessage, startCpuMeter, writeFleetRecords } from "./analysis.ts";
import { parse, parseInteger, parseLabel, parseNumber, parseSteps, UsageError } from "./args.ts";
import { ApiSession, MEMBERS_LIMIT } from "./api.ts";
import { nowUs } from "./clock.ts";
import { provenance, runMain, say, startRun, stopOnSignal } from "./common.ts";
import { Fleet, UserPool } from "./fleet.ts";
import {
  erroredStep,
  findLimit,
  judgeStep,
  renderLoadReport,
  type LoadStep,
  type LoadSummary,
} from "./report.ts";
import { JsonlWriter, writeJson } from "./results.ts";
import { MAX_CLIENTS, type TypingWindow } from "./samples.ts";
import { API_URL, Stack, WEB_ORIGIN } from "./stack.ts";
import { summarize } from "./stats.ts";

// Two threads for the observers; the rest of the machine minus two cores
// (the sync server and Postgres) for the other editors, at most 8.
const DEFAULT_OBSERVER_WORKERS = 2;
const DEFAULT_WORKERS = Math.max(
  1,
  Math.min(os.availableParallelism() - 2 - DEFAULT_OBSERVER_WORKERS, 8),
);
// Let the joins' presence and initial-sync traffic die down before typing.
const SETTLE_MS = 1000;

const USAGE = `Usage: pnpm bench:load [options]
  --steps 2,5,10,25,50,100,200  editors per step (increasing)
  --rate 5                      keystrokes per second per editor
  --warmup 5                    seconds of typing excluded at the start of each step
  --duration 20                 measured seconds per step
  --drain 10                    max seconds to wait for in-flight edits after typing stops
  --threshold 100               p95 limit in ms
  --observers 8                 editors per step that record receipts (all, if fewer)
  --observer-workers ${String(DEFAULT_OBSERVER_WORKERS).padEnd(10)} worker threads for the observers only
  --workers ${String(DEFAULT_WORKERS).padEnd(19)} worker threads for the other editors
  --no-awareness                don't send a cursor update after each keystroke
  --continue-past-limit         keep ramping after a step fails or is inconclusive
  --seed <int>                  seed for keystroke phases (random if omitted; recorded)
  --label <text>                a note kept with the results (e.g. "smoke")
Each editor is its own user and joins as a member; the API allows 500 members per
notebook, so steps stop below that.`;

const OPTIONS = {
  steps: { type: "string", default: "2,5,10,25,50,100,200" },
  rate: { type: "string", default: "5" },
  warmup: { type: "string", default: "5" },
  duration: { type: "string", default: "20" },
  drain: { type: "string", default: "10" },
  threshold: { type: "string", default: "100" },
  observers: { type: "string", default: "8" },
  "observer-workers": { type: "string", default: String(DEFAULT_OBSERVER_WORKERS) },
  workers: { type: "string", default: String(DEFAULT_WORKERS) },
  "no-awareness": { type: "boolean", default: false },
  "continue-past-limit": { type: "boolean", default: false },
  seed: { type: "string" },
  label: { type: "string" },
  help: { type: "boolean", default: false },
} as const;

function sleepUntil(targetUs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, (targetUs - nowUs()) / 1000)));
}

/**
 * The sync server's CPU over the window (from its own readings' timestamps,
 * so a slow answer doesn't skew it) and its memory, sampled about every
 * second. A busy server may answer a sample late; only the first and last
 * readings are required.
 */
async function watchSyncServer(stack: Stack, window: TypingWindow) {
  await sleepUntil(window.measureStartUs);
  const start = await stack.syncUsage(10_000);
  if (!start) return null;
  let peak = start.rssBytes;
  while (nowUs() + 1e6 < window.measureEndUs) {
    await sleepUntil(nowUs() + 1e6);
    const sample = await stack.syncUsage();
    if (sample) peak = Math.max(peak, sample.rssBytes);
  }
  await sleepUntil(window.measureEndUs);
  const end = await stack.syncUsage(10_000);
  if (!end) return null;
  peak = Math.max(peak, end.rssBytes);
  const cpuUs = end.userUs + end.systemUs - (start.userUs + start.systemUs);
  return {
    cpuPercentOfOneCore: (100 * cpuUs) / (end.atUs - start.atUs),
    rssPeakMb: peak / 2 ** 20,
    rssEndMb: end.rssBytes / 2 ** 20,
  };
}

/** This process's CPU (all its threads, so all the load clients) over the window. */
async function watchGenerator(window: TypingWindow): Promise<number> {
  await sleepUntil(window.measureStartUs);
  const stop = startCpuMeter();
  await sleepUntil(window.measureEndUs);
  return stop();
}

async function main(argv: string[]): Promise<void> {
  const args = parse(argv, OPTIONS);
  if (args.help) {
    say(USAGE);
    return;
  }
  const steps = parseSteps(args.steps, "steps");
  // The owner is a member too.
  if (steps.at(-1)! > Math.min(MAX_CLIENTS - 1, MEMBERS_LIMIT - 1)) {
    throw new UsageError(`--steps: at most ${MEMBERS_LIMIT - 1} editors per notebook`);
  }
  const params = {
    steps,
    ratePerSecond: parseNumber(args.rate, "rate", 0.1, 50),
    warmupSeconds: parseNumber(args.warmup, "warmup", 0, 600),
    durationSeconds: parseNumber(args.duration, "duration", 1, 3600),
    drainSeconds: parseNumber(args.drain, "drain", 0, 600),
    thresholdMs: parseNumber(args.threshold, "threshold", 1, 60_000),
    observers: parseInteger(args.observers, "observers", 1, MAX_CLIENTS),
    observerWorkers: parseInteger(args["observer-workers"], "observer-workers", 1, 64),
    workers: parseInteger(args.workers, "workers", 1, 64),
    awareness: !args["no-awareness"],
    continuePastLimit: args["continue-past-limit"],
    seed:
      args.seed === undefined
        ? Math.floor(Math.random() * 2 ** 31)
        : parseInteger(args.seed, "seed", 0, 2 ** 31 - 1),
    settleMs: SETTLE_MS,
  };
  const label = parseLabel(args.label);

  const run = startRun("load");
  say(`Load test ${run.runId}; results in ${run.dir}`);
  stopOnSignal();
  const samples = new JsonlWriter(path.join(run.dir, "samples.jsonl"));
  const records: LoadStep[] = [];
  let stack: Stack | null = null;
  let aborted: string | null = null;
  try {
    stack = await Stack.up({ web: false, logDir: run.dir, say });
    const owner = new ApiSession(API_URL, WEB_ORIGIN, "Bench owner");
    await owner.signIn();
    const users = new UserPool(API_URL, WEB_ORIGIN);

    for (const [stepIndex, clients] of steps.entries()) {
      say(`\nStep ${stepIndex + 1}/${steps.length}: ${clients} editors`);
      let record: LoadStep;
      let notebookId: string | null = null;
      let fleet: Fleet | null = null;
      try {
        notebookId = await owner.createNotebook(`Load test ${run.runId}: ${clients} editors`);
        fleet = await Fleet.join({
          apiUrl: API_URL,
          webOrigin: WEB_ORIGIN,
          notebookId,
          owner,
          users,
          clients,
          observers: params.observers,
          observerWorkers: params.observerWorkers,
          workers: params.workers,
          awareness: params.awareness,
        });
        await fleet.waitForCells(clients);
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        const typingStartUs = nowUs() + 500_000;
        const window: TypingWindow = {
          typingStartUs,
          measureStartUs: typingStartUs + params.warmupSeconds * 1e6,
          measureEndUs: typingStartUs + (params.warmupSeconds + params.durationSeconds) * 1e6,
        };
        say(`  typing for ${params.warmupSeconds + params.durationSeconds} s…`);
        const [drain, syncServer, generatorCpu] = await Promise.all([
          fleet.type(
            window,
            params.ratePerSecond,
            params.seed + stepIndex,
            params.drainSeconds * 1000,
          ),
          watchSyncServer(stack, window),
          watchGenerator(window),
        ]);
        const results = await fleet.results();
        await writeFleetRecords(samples, { step: clients }, results, window);
        const a = analyzeFleet(results, window, {
          generatorCpuPercent: generatorCpu,
          targetRatePerClient: params.ratePerSecond,
        });
        record = {
          clients,
          observers: results.observers.length,
          error: null,
          latencyMs: a.latencyMs,
          deliveries: a.deliveries,
          sends: a.sends,
          drain,
          traffic: a.traffic,
          syncServer,
          generator: a.generator,
          unexpectedCloses: results.unexpectedCloses,
          ...judgeStep(a.latencyMs, params.thresholdMs, a.generator),
        };
        say(
          `  ${a.latencyMs.count} samples (${a.deliveries.warmupExcluded} warm-up excluded, ` +
            `${a.deliveries.missing} missing): p50 ${a.latencyMs.p50?.toFixed(1)} ms, ` +
            `p95 ${a.latencyMs.p95?.toFixed(1)} ms → ${record.verdict}` +
            (record.failure ? ` (${record.failure})` : "") +
            (a.generator.limited ? `; load generator: ${a.generator.reasons.join("; ")}` : ""),
        );
      } catch (error) {
        // A step that can't complete is a result too: record why, and stop.
        record = erroredStep(clients, summarize([]), errorMessage(error));
        say(`  error: ${record.error}`);
      } finally {
        await fleet?.close();
        if (notebookId) await owner.deleteNotebook(notebookId).catch(() => {});
      }
      records.push(record);
      if (record.verdict === "error") break;
      if (record.verdict !== "pass" && !params.continuePastLimit) break;
    }
  } catch (error) {
    aborted = errorMessage(error);
  } finally {
    await samples.close();
    await stack?.down();
  }

  const summary: LoadSummary = {
    provenance: provenance(
      "load",
      run,
      label,
      stack,
      "process.hrtime (the machine-wide monotonic clock) in every client; send and receive " +
        "times are on the same clock.",
    ),
    parameters: params,
    thresholdMs: params.thresholdMs,
    steps: records,
    limit: findLimit(records),
    aborted,
  };
  writeJson(path.join(run.dir, "summary.json"), summary);
  writeFileSync(path.join(run.dir, "report.md"), renderLoadReport(summary));
  say(`\nWrote ${samples.lines} records, summary.json and report.md to ${run.dir}`);
  if (aborted) throw new Error(`the run stopped early: ${aborted}`);
}

runMain(USAGE, main);
