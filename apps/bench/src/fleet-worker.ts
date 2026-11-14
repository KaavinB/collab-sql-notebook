/**
 * A worker thread hosting some of the load clients. Spreading clients over
 * threads keeps one event loop from being the bottleneck: every client
 * applies every other client's edits, so the work grows with the square of
 * the client count. Observers (the clients that timestamp receipts) get
 * threads of their own, so busy clients can't delay their timestamps. Each
 * thread reports its own event-loop delay and how late its keystrokes went
 * out, so a report can say when the load generator, not the server, was the
 * limit.
 *
 * Driven by fleet.ts through messages; see FleetRequest for the protocol.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parentPort } from "node:worker_threads";

import { nowUs } from "./clock.ts";
import { emptyTraffic, LoadClient, type ClientSpec, type Traffic } from "./load-client.ts";
import { phaseOf, ReceiptColumns, type ReceiptMessage, type TypingWindow } from "./samples.ts";

// y-websocket adds one process "exit" listener per provider (and removes it
// on destroy), so a thread hosting more than 10 clients would print Node's
// MaxListenersExceededWarning, which looks like a leak but isn't.
process.setMaxListeners(0);

export type FleetRequest =
  | { type: "join"; specs: ClientSpec[] }
  | { type: "wait-cells"; count: number; timeoutMs: number }
  | {
      type: "start-typing";
      /** measureEndUs may be Infinity until finish-typing fixes it. */
      window: TypingWindow;
      intervalUs: number;
      phaseUs: Record<number, number>;
    }
  | { type: "finish-typing"; measureEndUs: number }
  | { type: "progress" }
  | { type: "sends" }
  | { type: "collect" }
  | { type: "stop" };

/**
 * How often the event-loop monitor's timer fires. Node records each whole
 * interval between firings (an idle loop reads about this much, plus timer
 * slack), so the resolution is subtracted to leave only the delay.
 */
const LOOP_MONITOR_RESOLUTION_MS = 5;

export interface LoopDelay {
  /** How late the worker's event loop ran over the measured window, in ms. */
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface WorkerResults {
  receipts: ReceiptMessage;
  sends: Array<{ index: number; times: number[] }>;
  /** Traffic counted between the start and the end of the measured window. */
  traffic: Traffic;
  loopDelay: LoopDelay | null;
  /** How late each measured keystroke went out versus its schedule, in µs. */
  sendLagUs: number[];
  unexpectedCloses: number;
}

export type FleetReply =
  | { type: "ok" }
  | { type: "error"; message: string }
  | { type: "typed" }
  | { type: "progress"; measuredReceipts: number }
  | { type: "sends"; sends: WorkerResults["sends"] }
  | { type: "results"; results: WorkerResults };

const port = parentPort;
if (!port) throw new Error("fleet-worker.ts runs as a worker thread");

const traffic = emptyTraffic();
const receipts = new ReceiptColumns();
const clients: LoadClient[] = [];
const sendLagUs: number[] = [];
let window: TypingWindow | null = null;
let trafficAtStart: Traffic | null = null;
let trafficAtEnd: Traffic | null = null;
let loopDelay: LoopDelay | null = null;

function reply(message: FleetReply, transfer: ArrayBuffer[] = []): void {
  port!.postMessage(message, transfer);
}

function delayUntil(targetUs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, (targetUs - nowUs()) / 1000)));
}

async function join(specs: ClientSpec[]): Promise<void> {
  const joined = specs.map((spec) => new LoadClient(spec, traffic, receipts));
  clients.push(...joined);
  await Promise.all(joined.map((client) => client.connect()));
  for (const client of joined) client.createCell();
}

async function waitCells(count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (clients.some((client) => client.cellCount() < count)) {
    if (Date.now() > deadline) {
      const least = Math.min(...clients.map((client) => client.cellCount()));
      throw new Error(`a client sees ${least} of ${count} cells after ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Resolves once finish-typing has fixed the end of the window. */
let endFixed: Promise<void> = Promise.resolve();
let fixEnd: (endUs: number) => void = () => {};
/** All typists and the window's snapshots, done. */
let typing: Promise<void> = Promise.resolve();

/**
 * Starts typing and returns at once. The window's end may still be open
 * (Infinity): the browser benchmark keeps the load running until the
 * browsers have finished, however long that takes, then fixes the end.
 */
function startTyping(w: TypingWindow, intervalUs: number, phaseUs: Record<number, number>): void {
  window = { ...w };
  const current = window;
  endFixed = new Promise((resolve) => {
    fixEnd = (endUs: number) => {
      current.measureEndUs = endUs;
      resolve();
    };
  });
  if (Number.isFinite(w.measureEndUs)) fixEnd(w.measureEndUs);
  typing = typeAll(current, intervalUs, phaseUs);
  // Awaited by finish-typing; a failure must not go unhandled before that.
  typing.catch(() => {});
}

async function typeAll(
  w: TypingWindow,
  intervalUs: number,
  phaseUs: Record<number, number>,
): Promise<void> {
  const monitor = monitorEventLoopDelay({ resolution: LOOP_MONITOR_RESOLUTION_MS });
  monitor.enable();
  const lateMs = (ns: number) => Math.max(0, ns / 1e6 - LOOP_MONITOR_RESOLUTION_MS);
  const snapshots = (async () => {
    await delayUntil(w.measureStartUs);
    monitor.reset();
    trafficAtStart = { ...traffic };
    await endFixed;
    await delayUntil(w.measureEndUs);
    trafficAtEnd = { ...traffic };
    monitor.disable();
    loopDelay = {
      p50Ms: lateMs(monitor.percentile(50)),
      p99Ms: lateMs(monitor.percentile(99)),
      maxMs: lateMs(monitor.max),
    };
  })();
  const typists = clients.map(async (client) => {
    const offset = phaseUs[client.spec.index] ?? 0;
    for (let k = 0; ; k++) {
      // The end is re-read every time: it may be fixed while typing.
      const scheduledUs = w.typingStartUs + offset + k * intervalUs;
      if (scheduledUs >= w.measureEndUs) return;
      await delayUntil(scheduledUs);
      const now = nowUs();
      // A keystroke that comes due after the window closed is not sent:
      // nothing sent then could be measured.
      if (now >= w.measureEndUs) return;
      if (now >= w.measureStartUs) sendLagUs.push(now - scheduledUs);
      client.sendEdit();
    }
  });
  await Promise.all([...typists, snapshots]);
}

function measuredReceipts(): number {
  if (!window) return 0;
  let count = 0;
  for (let i = 0; i < receipts.length; i++) {
    if (phaseOf(receipts.sentAtUs[i]!, window) === "measured") count++;
  }
  return count;
}

function difference(end: Traffic | null, start: Traffic | null): Traffic {
  const out = emptyTraffic();
  if (!end || !start) return out;
  for (const key of Object.keys(out) as (keyof Traffic)[]) out[key] = end[key] - start[key];
  return out;
}

function sends(): WorkerResults["sends"] {
  return clients.map((client) => ({ index: client.spec.index, times: client.sends }));
}

function collect(): void {
  const { message, transfer } = receipts.toMessage();
  reply(
    {
      type: "results",
      results: {
        receipts: message,
        sends: sends(),
        traffic: difference(trafficAtEnd, trafficAtStart),
        loopDelay,
        sendLagUs,
        unexpectedCloses: clients.reduce((sum, client) => sum + client.unexpectedCloses, 0),
      },
    },
    transfer,
  );
}

port.on("message", (request: FleetRequest) => {
  const run = async () => {
    switch (request.type) {
      case "join":
        await join(request.specs);
        return reply({ type: "ok" });
      case "wait-cells":
        await waitCells(request.count, request.timeoutMs);
        return reply({ type: "ok" });
      case "start-typing":
        startTyping(request.window, request.intervalUs, request.phaseUs);
        return reply({ type: "ok" });
      case "finish-typing":
        fixEnd(request.measureEndUs);
        await typing;
        return reply({ type: "typed" });
      case "progress":
        return reply({ type: "progress", measuredReceipts: measuredReceipts() });
      case "sends":
        return reply({ type: "sends", sends: sends() });
      case "collect":
        return collect();
      case "stop":
        for (const client of clients) client.stop();
        clients.length = 0;
        return reply({ type: "ok" });
    }
  };
  run().catch((error: unknown) =>
    reply({ type: "error", message: error instanceof Error ? error.message : String(error) }),
  );
});
