/**
 * Sync-latency benchmark: keystroke-to-remote-render time between two real
 * browsers, alone and with many other editors in the room.
 *
 * WHAT IS MEASURED
 *   Two headless Chromium browsers (separate browser processes, Playwright)
 *   open the same notebook through the real web app, API and sync server.
 *   Browser A types into a sql cell at a human rate (default 5 keystrokes/s);
 *   for each keystroke, the time from the keydown event on A's page to the
 *   first DOM mutation on B's page that shows the character. That covers
 *   CodeMirror and y-codemirror on A, the WebSocket provider, the sync
 *   server, and y-codemirror and CodeMirror on B. The first keystrokes
 *   (default 20) are a warm-up, excluded and counted. At the end, both pages'
 *   text must equal exactly what was typed.
 *
 *   "Many clients": each scenario in --load-clients (default 0 and 20) adds
 *   that many headless Node Yjs clients (y-websocket over `ws`, real tickets)
 *   to the same notebook, each typing in its own cell at a human rate, so
 *   both browsers also render everyone else's edits and cursors. The load
 *   starts LOAD_WARMUP_S before the browser's first keystroke and keeps
 *   going until LOAD_TAIL_S after its last one has arrived, however long the
 *   browser part takes; the report confirms the load covered the typing.
 *
 *   One clock: both pages report performance.timeOrigin + performance.now().
 *   Each browser process derives that from the wall clock separately, so
 *   before and after typing this script measures each page's offset from its
 *   own clock by round trips (NTP-style, the shortest of CLOCK_PROBES round
 *   trips wins) and subtracts the difference; the report shows the correction
 *   and its error bound. Measuring in this process instead (time the key
 *   press here, and be told when B sees it) would add two DevTools-protocol
 *   hops to every sample, which is why the pages time themselves.
 *
 * WHAT ISN'T
 *   The paint after the DOM change, and real network distance: everything
 *   runs on one machine. The load clients aren't browsers (no rendering).
 *   Typed characters are letters only, so the editor's bracket and quote
 *   auto-closing never inserts extra text.
 *
 * WHAT IT RELIES ON IN THE WEB APP
 *   The typed-into cell is created through the shared document (as the load
 *   clients create theirs), not by clicking the UI, so only these need to
 *   stay: `data-cell-id` on each cell, CodeMirror's `.cm-content`/`.cm-line`,
 *   y-codemirror's caret classes, and `data-testid="sync-status"` reading
 *   "Live".
 *
 * HOW TO RERUN
 *   docker compose up -d        # Postgres; the taxi data isn't needed
 *   pnpm exec playwright install chromium   # once, if browsers are missing
 *   pnpm bench:latency          # builds the web app into apps/web/.next-bench and
 *                               # starts web 3200, API 8200, sync 8220
 *   pnpm bench:latency --load-clients 0,10,50 --keystrokes 300
 *   pnpm bench:latency --help
 *   Results go to data/bench-results/<run-id>/ (samples.jsonl, summary.json,
 *   report.md), also when a scenario fails. Run it on a quiet machine.
 */
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { analyzeFleet, errorMessage, startCpuMeter, writeFleetRecords } from "./analysis.ts";
import { parse, parseInteger, parseLabel, parseNumber, parseSteps, UsageError } from "./args.ts";
import { ApiSession, MEMBERS_LIMIT } from "./api.ts";
import { epochMs, estimateOffset, nowUs, type ClockProbe, type Offset } from "./clock.ts";
import { provenance, runMain, say, startRun, stopOnSignal } from "./common.ts";
import { Fleet, UserPool } from "./fleet.ts";
import { pairKeystrokes } from "./keystrokes.ts";
import { emptyTraffic, LoadClient } from "./load-client.ts";
import { installAppearanceRecorder, installKeydownRecorder, readClock } from "./page-probes.ts";
import {
  renderLatencyReport,
  type LatencyLoad,
  type LatencyScenario,
  type LatencySummary,
} from "./report.ts";
import { JsonlWriter, writeJson } from "./results.ts";
import { MAX_CLIENTS, ReceiptColumns, type TypingWindow } from "./samples.ts";
import { API_URL, Stack, WEB_ORIGIN } from "./stack.ts";
import { summarize } from "./stats.ts";

/** Seconds the load types before the browser starts, so the room is at full load when measured. */
const LOAD_WARMUP_S = 3;
/** Seconds the load keeps typing after the browser's last keystroke arrived. */
const LOAD_TAIL_S = 2;
/** Longest wait for the load clients' last edits to arrive after they stop. */
const FLEET_DRAIN_MS = 10_000;
/** Longest wait for the browser's last keystroke to appear on the other page. */
const BROWSER_DRAIN_MS = 10_000;
/** Round trips per clock-offset estimate; more only helps if one lands on an idle moment. */
const CLOCK_PROBES = 15;
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const TYPIST_CELL_ID = "bench-typist";
// One thread for the observers; the other threads leave about four cores for
// the two browsers, the sync server and Postgres, at most 6.
const DEFAULT_OBSERVER_WORKERS = 1;
const DEFAULT_WORKERS = Math.max(
  1,
  Math.min(os.availableParallelism() - 4 - DEFAULT_OBSERVER_WORKERS, 6),
);

const USAGE = `Usage: pnpm bench:latency [options]
  --load-clients 0,20     extra Node editors per scenario (0 = the two browsers alone)
  --keystrokes 120        keystrokes typed per scenario, warm-up included
  --warmup 20             first keystrokes excluded
  --rate 5                the browser's keystrokes per second
  --load-rate 5           each Node editor's keystrokes per second
  --observers 4           Node editors that record their own latency (reported alongside)
  --observer-workers ${String(DEFAULT_OBSERVER_WORKERS).padEnd(4)} worker threads for those observers only
  --workers ${String(DEFAULT_WORKERS).padEnd(13)} worker threads for the other Node editors
  --no-awareness          Node editors send no cursor updates
  --seed <int>            seed for the Node editors' keystroke phases (recorded)
  --label <text>          a note kept with the results (e.g. "smoke")`;

const OPTIONS = {
  "load-clients": { type: "string", default: "0,20" },
  keystrokes: { type: "string", default: "120" },
  warmup: { type: "string", default: "20" },
  rate: { type: "string", default: "5" },
  "load-rate": { type: "string", default: "5" },
  observers: { type: "string", default: "4" },
  "observer-workers": { type: "string", default: String(DEFAULT_OBSERVER_WORKERS) },
  workers: { type: "string", default: String(DEFAULT_WORKERS) },
  "no-awareness": { type: "boolean", default: false },
  seed: { type: "string" },
  label: { type: "string" },
  help: { type: "boolean", default: false },
} as const;

function sleepUntil(targetUs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, (targetUs - nowUs()) / 1000)));
}

async function clockOffset(page: Page): Promise<Offset> {
  const probes: ClockProbe[] = [];
  for (let i = 0; i < CLOCK_PROBES; i++) {
    const before = epochMs();
    const remote = await page.evaluate(readClock);
    const after = epochMs();
    probes.push({ before, remote, after });
  }
  return estimateOffset(probes);
}

/** A browser of its own (its own processes), signed in as `name`. */
async function person(name: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ baseURL: WEB_ORIGIN })).newPage();
  const response = await page.request.post(`${API_URL}/auth/dev-login`, {
    data: { name },
    headers: { Origin: WEB_ORIGIN },
  });
  if (!response.ok()) throw new Error(`dev sign-in failed (${response.status()})`);
  return { browser, page };
}

async function openNotebook(page: Page, notebookId: string, token: string): Promise<void> {
  const accepted = await page.request.post(`${API_URL}/share-links/accept`, {
    data: { token },
    headers: { Origin: WEB_ORIGIN },
  });
  if (!accepted.ok()) throw new Error(`joining failed (${accepted.status()})`);
  await page.goto(`/notebooks/${notebookId}`);
  await page.getByTestId("sync-status").filter({ hasText: "Live" }).waitFor({ timeout: 30_000 });
}

/**
 * Adds the empty sql cell the browser types into through the shared
 * document, the way the load clients add theirs, so the benchmark doesn't
 * depend on the notebook's buttons. Waits until both pages show it.
 */
async function createTypistCell(owner: ApiSession, notebookId: string, pages: Page[]) {
  const ticket = await owner.syncTicket(notebookId);
  const client = new LoadClient(
    {
      index: MAX_CLIENTS - 1, // never a fleet index, and it sends no stamps
      notebookId,
      syncUrl: ticket.url,
      ticket: ticket.ticket,
      origin: WEB_ORIGIN,
      observer: false,
      awareness: false,
      cellId: TYPIST_CELL_ID,
    },
    emptyTraffic(),
    new ReceiptColumns(0),
  );
  try {
    await client.connect();
    client.createCell();
    for (const page of pages) {
      await page
        .locator(`[data-cell-id="${TYPIST_CELL_ID}"] .cm-content`)
        .waitFor({ timeout: 30_000 });
    }
  } finally {
    client.stop();
  }
}

async function waitForCellCount(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (n) => document.querySelectorAll("[data-cell-id]").length >= n,
    count,
    { timeout: 60_000 },
  );
}

/** The cell's text as a page's editor shows it, without collaborators' carets or the placeholder. */
function shownText(page: Page, cellId: string): Promise<string> {
  return page.evaluate((id) => {
    const content = document.querySelector(`[data-cell-id="${CSS.escape(id)}"] .cm-content`);
    if (!content) return "";
    return [...content.querySelectorAll(".cm-line")]
      .map((line) => {
        const copy = line.cloneNode(true) as Element;
        copy
          .querySelectorAll(".cm-ySelectionCaret, .cm-ySelectionInfo, .cm-placeholder")
          .forEach((node) => node.remove());
        return copy.textContent ?? "";
      })
      .join("\n");
  }, cellId);
}

type Params = {
  keystrokes: number;
  warmupKeystrokes: number;
  ratePerSecond: number;
  loadRatePerSecond: number;
  observers: number;
  observerWorkers: number;
  workers: number;
  awareness: boolean;
  seed: number;
};

interface Context {
  params: Params;
  owner: ApiSession;
  users: UserPool;
  typist: Page;
  watcher: Page;
  samples: JsonlWriter;
  runId: string;
}

function erroredScenario(extra: number, target: number, message: string): LatencyScenario {
  return {
    loadClients: extra,
    error: message,
    keystrokes: { measured: 0, warmupExcluded: 0, missing: 0 },
    typingRate: { achievedPerSecond: null, targetPerSecond: target },
    latencyMs: summarize([]),
    clocks: null,
    textMatches: null,
    load: null,
  };
}

async function runScenario(ctx: Context, extra: number, index: number): Promise<LatencyScenario> {
  const { params, owner, typist, watcher } = ctx;
  const notebookId = await owner.createNotebook(`Latency ${ctx.runId}: +${extra}`);
  let fleet: Fleet | null = null;
  try {
    const token = await owner.shareLink(notebookId, "editor");
    await openNotebook(typist, notebookId, token);
    await openNotebook(watcher, notebookId, token);
    await createTypistCell(owner, notebookId, [typist, watcher]);

    let stopCpu: (() => number) | null = null;
    if (extra > 0) {
      fleet = await Fleet.join({
        apiUrl: API_URL,
        webOrigin: WEB_ORIGIN,
        notebookId,
        owner,
        users: ctx.users,
        clients: extra,
        observers: params.observers,
        observerWorkers: params.observerWorkers,
        workers: params.workers,
        awareness: params.awareness,
      });
      await fleet.waitForCells(extra + 1);
      await waitForCellCount(typist, extra + 1);
      await waitForCellCount(watcher, extra + 1);
      // The end stays open until the browser has finished.
      const typingStartUs = nowUs() + 500_000;
      const window: TypingWindow = {
        typingStartUs,
        measureStartUs: typingStartUs + LOAD_WARMUP_S * 1e6,
        measureEndUs: Infinity,
      };
      await fleet.startTyping(window, params.loadRatePerSecond, params.seed + index);
      await sleepUntil(window.measureStartUs);
      stopCpu = startCpuMeter();
    }

    const cellSelector = `[data-cell-id="${TYPIST_CELL_ID}"]`;
    const baseText = await shownText(typist, TYPIST_CELL_ID);
    await typist.evaluate(installKeydownRecorder);
    const baseLength = await watcher.evaluate(installAppearanceRecorder, TYPIST_CELL_ID);
    const before = [await clockOffset(typist), await clockOffset(watcher)] as const;
    await typist.locator(`${cellSelector} .cm-content`).click();

    say(`  typing ${params.keystrokes} keystrokes at ${params.ratePerSecond}/s…`);
    const intervalUs = 1e6 / params.ratePerSecond;
    const browserStartUs = nowUs();
    const startUs = browserStartUs + 200_000;
    let typed = "";
    for (let i = 0; i < params.keystrokes; i++) {
      await sleepUntil(startUs + i * intervalUs);
      const key = LETTERS[i % LETTERS.length]!;
      await typist.keyboard.press(key);
      typed += key;
    }
    await watcher
      .waitForFunction(
        (target) => (window.__benchTextLength?.() ?? -1) >= target,
        baseLength + params.keystrokes,
        { timeout: BROWSER_DRAIN_MS },
      )
      .catch(() => {});
    const browserEndUs = nowUs();

    let load: LatencyLoad | null = null;
    if (fleet && stopCpu) {
      const window = await fleet.finishTyping(nowUs() + LOAD_TAIL_S * 1e6);
      const generatorCpuPercent = stopCpu();
      const drain = await fleet.drain(FLEET_DRAIN_MS);
      const results = await fleet.results();
      await writeFleetRecords(ctx.samples, { scenario: extra }, results, window);
      const a = analyzeFleet(results, window, {
        generatorCpuPercent,
        targetRatePerClient: params.loadRatePerSecond,
      });
      load = {
        clients: extra,
        coveredTyping:
          window.measureStartUs <= browserStartUs && window.measureEndUs >= browserEndUs,
        drain,
        deliveries: a.deliveries,
        unexpectedCloses: results.unexpectedCloses,
        traffic: a.traffic,
        generator: a.generator,
        nodeLatencyMs: a.latencyMs,
      };
    }
    const after = [await clockOffset(typist), await clockOffset(watcher)] as const;

    const keydownMs = await typist.evaluate(() => window.__benchKeydowns ?? []);
    const appearedAt = await watcher.evaluate(() => window.__benchAppeared ?? []);
    if (keydownMs.length !== params.keystrokes) {
      throw new Error(`recorded ${keydownMs.length} keydowns for ${params.keystrokes} keystrokes`);
    }
    const typistOffsetMs = (before[0].offsetMs + after[0].offsetMs) / 2;
    const watcherOffsetMs = (before[1].offsetMs + after[1].offsetMs) / 2;
    const pairing = pairKeystrokes({
      keydownMs,
      appearedAt,
      baseLength,
      warmup: params.warmupKeystrokes,
      typistOffsetMs,
      watcherOffsetMs,
    });
    for (const sample of pairing.samples) {
      await ctx.samples.write({ scenario: extra, kind: "keystroke", ...sample });
    }
    const expected = baseText + typed;
    const textMatches = {
      typist: (await shownText(typist, TYPIST_CELL_ID)) === expected,
      watcher: (await shownText(watcher, TYPIST_CELL_ID)) === expected,
    };
    const spanMs = keydownMs[keydownMs.length - 1]! - keydownMs[0]!;
    const differenceBefore = before[1].offsetMs - before[0].offsetMs;
    const differenceAfter = after[1].offsetMs - after[0].offsetMs;
    const latencyMs = summarize(pairing.measuredMs, pairing.missing);
    say(
      `  ${latencyMs.count} keystrokes (${pairing.warmup} warm-up excluded, ` +
        `${pairing.missing} missing): p50 ${latencyMs.p50?.toFixed(1)} ms, ` +
        `p95 ${latencyMs.p95?.toFixed(1)} ms` +
        (textMatches.typist && textMatches.watcher ? "" : " — TEXT DIFFERS FROM WHAT WAS TYPED") +
        (load && !load.coveredTyping ? " — LOAD DIDN'T COVER THE TYPING" : "") +
        (load?.generator.limited ? `; load generator: ${load.generator.reasons.join("; ")}` : ""),
    );
    return {
      loadClients: extra,
      error: null,
      keystrokes: {
        measured: pairing.measuredMs.length,
        warmupExcluded: pairing.warmup,
        missing: pairing.missing,
      },
      typingRate: {
        achievedPerSecond: spanMs > 0 ? ((keydownMs.length - 1) * 1000) / spanMs : null,
        targetPerSecond: params.ratePerSecond,
      },
      latencyMs,
      clocks: {
        typistOffsetMs,
        watcherOffsetMs,
        // Both pages' probe error bounds, plus half of how far the offsets
        // moved between the probes before and after typing.
        uncertaintyMs:
          Math.max(before[0].uncertaintyMs, after[0].uncertaintyMs) +
          Math.max(before[1].uncertaintyMs, after[1].uncertaintyMs) +
          Math.abs(differenceAfter - differenceBefore) / 2,
        driftMs: differenceAfter - differenceBefore,
      },
      textMatches,
      load,
    };
  } finally {
    await fleet?.close();
    await owner.deleteNotebook(notebookId).catch(() => {});
  }
}

async function main(argv: string[]): Promise<void> {
  const args = parse(argv, OPTIONS);
  if (args.help) {
    say(USAGE);
    return;
  }
  const loadClients = parseSteps(args["load-clients"], "load-clients", { allowZero: true });
  // The owner and the two browsers' users are members too.
  if (loadClients.at(-1)! > Math.min(MAX_CLIENTS - 2, MEMBERS_LIMIT - 3)) {
    throw new UsageError(`--load-clients: at most ${MEMBERS_LIMIT - 3} per notebook`);
  }
  const params: Params = {
    keystrokes: parseInteger(args.keystrokes, "keystrokes", 2, 10_000),
    warmupKeystrokes: parseInteger(args.warmup, "warmup", 0, 9_999),
    ratePerSecond: parseNumber(args.rate, "rate", 0.1, 50),
    loadRatePerSecond: parseNumber(args["load-rate"], "load-rate", 0.1, 50),
    observers: parseInteger(args.observers, "observers", 1, MAX_CLIENTS),
    observerWorkers: parseInteger(args["observer-workers"], "observer-workers", 1, 64),
    workers: parseInteger(args.workers, "workers", 1, 64),
    awareness: !args["no-awareness"],
    seed:
      args.seed === undefined
        ? Math.floor(Math.random() * 2 ** 31)
        : parseInteger(args.seed, "seed", 0, 2 ** 31 - 1),
  };
  if (params.warmupKeystrokes >= params.keystrokes) {
    throw new UsageError("--warmup must be smaller than --keystrokes");
  }
  const label = parseLabel(args.label);

  const run = startRun("latency");
  say(`Latency benchmark ${run.runId}; results in ${run.dir}`);
  stopOnSignal();
  const samples = new JsonlWriter(path.join(run.dir, "samples.jsonl"));
  const scenarios: LatencyScenario[] = [];
  const browsers: Browser[] = [];
  let browserVersion = "unknown";
  let stack: Stack | null = null;
  let aborted: string | null = null;
  try {
    stack = await Stack.up({ web: true, logDir: run.dir, say });
    const owner = new ApiSession(API_URL, WEB_ORIGIN, "Bench owner");
    await owner.signIn();
    const typist = await person("Bench typist");
    browsers.push(typist.browser);
    const watcher = await person("Bench watcher");
    browsers.push(watcher.browser);
    browserVersion = `Chromium ${typist.browser.version()}`;
    const ctx: Context = {
      params,
      owner,
      users: new UserPool(API_URL, WEB_ORIGIN),
      typist: typist.page,
      watcher: watcher.page,
      samples,
      runId: run.runId,
    };

    for (const [index, extra] of loadClients.entries()) {
      say(`\nScenario ${index + 1}/${loadClients.length}: 2 browsers + ${extra} Node editors`);
      let scenario: LatencyScenario;
      try {
        scenario = await runScenario(ctx, extra, index);
      } catch (error) {
        // Record why, and stop: later scenarios would meet the same problem.
        scenario = erroredScenario(extra, params.ratePerSecond, errorMessage(error));
        say(`  error: ${scenario.error}`);
      }
      scenarios.push(scenario);
      if (scenario.error) break;
    }
  } catch (error) {
    aborted = errorMessage(error);
  } finally {
    await samples.close();
    for (const browser of browsers) await browser.close().catch(() => {});
    await stack?.down();
  }

  const summary: LatencySummary = {
    provenance: provenance(
      "latency",
      run,
      label,
      stack,
      "each page's performance.timeOrigin + performance.now(), corrected by its offset from " +
        "this process's clock measured with round trips before and after typing (see report).",
    ),
    parameters: {
      loadClients,
      ...params,
      loadWarmupSeconds: LOAD_WARMUP_S,
      loadTailSeconds: LOAD_TAIL_S,
      fleetDrainMs: FLEET_DRAIN_MS,
      browserDrainMs: BROWSER_DRAIN_MS,
      clockProbes: CLOCK_PROBES,
    },
    browser: browserVersion,
    scenarios,
    aborted,
  };
  writeJson(path.join(run.dir, "summary.json"), summary);
  writeFileSync(path.join(run.dir, "report.md"), renderLatencyReport(summary));
  say(`\nWrote ${samples.lines} records, summary.json and report.md to ${run.dir}`);
  if (aborted) throw new Error(`the run stopped early: ${aborted}`);
}

runMain(USAGE, main);
