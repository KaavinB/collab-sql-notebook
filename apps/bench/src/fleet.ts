/**
 * The coordinator side of the load clients: gets each client a real ticket
 * from the API, spreads the clients over worker threads, runs one typing
 * window, waits for in-flight edits, and gathers the samples.
 */
import { Worker } from "node:worker_threads";

import { ApiSession, mapLimit } from "./api.ts";
import { nowUs } from "./clock.ts";
import type { FleetReply, FleetRequest, LoopDelay } from "./fleet-worker.ts";
import { emptyTraffic, type ClientSpec, type Traffic } from "./load-client.ts";
import {
  MAX_CLIENTS,
  phaseOf,
  ReceiptColumns,
  type SendLog,
  type TypingWindow,
} from "./samples.ts";

/** Deterministic PRNG (mulberry32), so a run's keystroke phases can be replayed from its seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Users for load clients, signed in once and reused across steps. Client i
 * is user i, so each is its own person in the room (its own presence entry),
 * as in a real notebook.
 */
export class UserPool {
  private readonly users: ApiSession[] = [];
  private readonly apiUrl: string;
  private readonly webOrigin: string;

  constructor(apiUrl: string, webOrigin: string) {
    this.apiUrl = apiUrl;
    this.webOrigin = webOrigin;
  }

  async take(count: number): Promise<ApiSession[]> {
    const missing = Array.from({ length: Math.max(0, count - this.users.length) }, (_, i) => i);
    const start = this.users.length;
    const created = await mapLimit(missing, 8, async (i) => {
      const session = new ApiSession(this.apiUrl, this.webOrigin, `Bench editor ${start + i}`);
      await session.signIn();
      return session;
    });
    this.users.push(...created);
    return this.users.slice(0, count);
  }
}

class WorkerHandle {
  private readonly worker: Worker;
  private pending: { resolve: (reply: FleetReply) => void; reject: (e: Error) => void } | null =
    null;
  private failure: Error | null = null;

  constructor() {
    this.worker = new Worker(new URL("./fleet-worker.ts", import.meta.url));
    this.worker.on("message", (reply: FleetReply) => {
      const pending = this.pending;
      this.pending = null;
      if (!pending) return;
      if (reply.type === "error") pending.reject(new Error(reply.message));
      else pending.resolve(reply);
    });
    this.worker.on("error", (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failure = failure;
      this.pending?.reject(failure);
      this.pending = null;
    });
  }

  request(message: FleetRequest): Promise<FleetReply> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error("worker is busy"));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage(message);
    });
  }

  terminate(): Promise<number> {
    return this.worker.terminate();
  }
}

export type WorkerRole = "observer" | "busy";

export interface WorkerLayout {
  role: WorkerRole;
  /** Positions in the fleet (0-based) of the clients this worker hosts. */
  clients: number[];
}

/**
 * Which worker thread hosts which client. The first `observers` clients
 * record receipts; they get `observerWorkers` threads of their own, shared
 * with no other client, so the busy clients' work can't delay the moment a
 * receipt is timestamped. The rest are spread over `busyWorkers` threads.
 * Round-robin within each group; empty threads aren't created.
 */
export function layoutWorkers(
  clients: number,
  observers: number,
  observerWorkers: number,
  busyWorkers: number,
): WorkerLayout[] {
  const observing = Math.min(clients, observers);
  const busy = clients - observing;
  const group = (role: WorkerRole, first: number, count: number, threads: number) => {
    const n = Math.max(1, Math.min(threads, count));
    const layout: WorkerLayout[] = Array.from({ length: count ? n : 0 }, () => ({
      role,
      clients: [],
    }));
    for (let i = 0; i < count; i++) layout[i % n]!.clients.push(first + i);
    return layout;
  };
  return [
    ...group("observer", 0, observing, observerWorkers),
    ...group("busy", observing, busy, busyWorkers),
  ];
}

export interface FleetOptions {
  apiUrl: string;
  webOrigin: string;
  notebookId: string;
  /** Owner's session, for the share link the clients join through. */
  owner: ApiSession;
  users: UserPool;
  clients: number;
  /** Clients at positions < observers record receipts. */
  observers: number;
  /** Threads for the observers only. */
  observerWorkers: number;
  /** Threads for the other clients. */
  workers: number;
  awareness: boolean;
}

export interface FleetResults {
  receipts: ReceiptColumns;
  sends: SendLog;
  observers: number[];
  traffic: Traffic;
  observerLoopDelay: LoopDelay[];
  busyLoopDelay: LoopDelay[];
  sendLagUs: number[];
  unexpectedCloses: number;
}

export interface Drain {
  /** Every observer received every measured edit. */
  complete: boolean;
  waitedMs: number;
}

export class Fleet {
  private readonly handles: WorkerHandle[];
  private readonly specsByWorker: ClientSpec[][];
  private readonly roles: WorkerRole[];
  readonly observers: number[];
  private window: TypingWindow | null = null;

  private constructor(
    handles: WorkerHandle[],
    specsByWorker: ClientSpec[][],
    roles: WorkerRole[],
    observers: number[],
  ) {
    this.handles = handles;
    this.specsByWorker = specsByWorker;
    this.roles = roles;
    this.observers = observers;
  }

  /** Signs clients in, gets their tickets and connects them; each adds its own cell. */
  static async join(options: FleetOptions): Promise<Fleet> {
    if (options.clients > MAX_CLIENTS - 1) throw new RangeError(`at most ${MAX_CLIENTS - 1}`);
    const users = await options.users.take(options.clients);
    const token = await options.owner.shareLink(options.notebookId, "editor");
    // Tickets last 60 s, so they're fetched right before connecting.
    const tickets = await mapLimit(users, 8, async (user) => {
      await user.acceptShareLink(token);
      return user.syncTicket(options.notebookId);
    });
    const layout = layoutWorkers(
      options.clients,
      options.observers,
      options.observerWorkers,
      options.workers,
    );
    const observers: number[] = [];
    const specsByWorker = layout.map((worker) =>
      worker.clients.map((index): ClientSpec => {
        const observer = worker.role === "observer";
        if (observer) observers.push(index);
        return {
          index,
          notebookId: options.notebookId,
          syncUrl: tickets[index]!.url,
          ticket: tickets[index]!.ticket,
          origin: options.webOrigin,
          observer,
          awareness: options.awareness,
        };
      }),
    );
    const handles = specsByWorker.map(() => new WorkerHandle());
    const fleet = new Fleet(
      handles,
      specsByWorker,
      layout.map((worker) => worker.role),
      observers.sort((a, b) => a - b),
    );
    try {
      await fleet.all((_, specs) => ({ type: "join", specs }));
    } catch (error) {
      await fleet.close();
      throw error;
    }
    return fleet;
  }

  private all(
    message: (handle: WorkerHandle, specs: ClientSpec[]) => FleetRequest,
  ): Promise<FleetReply[]> {
    return Promise.all(
      this.handles.map((handle, i) => handle.request(message(handle, this.specsByWorker[i]!))),
    );
  }

  /** Waits until every client's document has at least `count` cells. */
  async waitForCells(count: number, timeoutMs = 60_000): Promise<void> {
    await this.all(() => ({ type: "wait-cells", count, timeoutMs }));
  }

  /**
   * Starts every client typing at `ratePerSecond`, each with its own random
   * phase (replayable from `seed`), from window.typingStartUs. The window's
   * end may be Infinity, to be fixed later with finishTyping.
   */
  async startTyping(window: TypingWindow, ratePerSecond: number, seed: number): Promise<void> {
    const intervalUs = 1e6 / ratePerSecond;
    const random = seededRandom(seed);
    const phaseUs: Record<number, number> = {};
    for (const specs of this.specsByWorker) {
      for (const spec of specs) phaseUs[spec.index] = Math.floor(random() * intervalUs);
    }
    this.window = { ...window };
    await this.all(() => ({ type: "start-typing", window, intervalUs, phaseUs }));
  }

  /** Fixes the end of the measured window and resolves once every client has stopped typing. */
  async finishTyping(measureEndUs: number): Promise<TypingWindow> {
    if (!this.window) throw new Error("startTyping() first");
    this.window.measureEndUs = measureEndUs;
    await this.all(() => ({ type: "finish-typing", measureEndUs }));
    return { ...this.window };
  }

  /** Waits up to `drainMs` for every observer to receive every measured edit (checked at least once). */
  async drain(drainMs: number): Promise<Drain> {
    const window = this.window;
    if (!window || !Number.isFinite(window.measureEndUs)) throw new Error("finishTyping() first");
    const expected = await this.expectedMeasured(window);
    const start = nowUs();
    const deadline = Date.now() + drainMs;
    for (;;) {
      const replies = await this.all(() => ({ type: "progress" }));
      const received = replies.reduce(
        (sum, reply) => sum + (reply.type === "progress" ? reply.measuredReceipts : 0),
        0,
      );
      if (received >= expected) return { complete: true, waitedMs: (nowUs() - start) / 1000 };
      if (Date.now() >= deadline) return { complete: false, waitedMs: (nowUs() - start) / 1000 };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** startTyping + finishTyping + drain, for a window whose end is known in advance. */
  async type(
    window: TypingWindow,
    ratePerSecond: number,
    seed: number,
    drainMs: number,
  ): Promise<Drain> {
    await this.startTyping(window, ratePerSecond, seed);
    await this.finishTyping(window.measureEndUs);
    return this.drain(drainMs);
  }

  /** Measured deliveries every observer should get: all other clients' measured edits. */
  private async expectedMeasured(window: TypingWindow): Promise<number> {
    const replies = await this.all(() => ({ type: "sends" }));
    const measured = new Map<number, number>();
    let total = 0;
    for (const reply of replies) {
      if (reply.type !== "sends") throw new Error(`unexpected reply ${reply.type}`);
      for (const { index, times } of reply.sends) {
        const count = times.filter((t) => phaseOf(t, window) === "measured").length;
        measured.set(index, count);
        total += count;
      }
    }
    return this.observers.reduce((sum, observer) => sum + total - (measured.get(observer) ?? 0), 0);
  }

  /** Every receipt and send, merged over the workers. */
  async results(): Promise<FleetResults> {
    const replies = await this.all(() => ({ type: "collect" }));
    const receipts = new ReceiptColumns();
    const sends = new Map<number, number[]>();
    const traffic = emptyTraffic();
    const sendLagUs: number[] = [];
    const observerLoopDelay: LoopDelay[] = [];
    const busyLoopDelay: LoopDelay[] = [];
    let unexpectedCloses = 0;
    replies.forEach((reply, i) => {
      if (reply.type !== "results") throw new Error(`unexpected reply ${reply.type}`);
      const result = reply.results;
      receipts.append(ReceiptColumns.fromMessage(result.receipts));
      for (const s of result.sends) sends.set(s.index, s.times);
      for (const key of Object.keys(traffic) as (keyof Traffic)[]) {
        traffic[key] += result.traffic[key];
      }
      sendLagUs.push(...result.sendLagUs);
      if (result.loopDelay) {
        (this.roles[i] === "observer" ? observerLoopDelay : busyLoopDelay).push(result.loopDelay);
      }
      unexpectedCloses += result.unexpectedCloses;
    });
    return {
      receipts,
      sends,
      observers: this.observers,
      traffic,
      observerLoopDelay,
      busyLoopDelay,
      sendLagUs,
      unexpectedCloses,
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.handles.map((handle) => handle.request({ type: "stop" })));
    await Promise.allSettled(this.handles.map((handle) => handle.terminate()));
  }
}
