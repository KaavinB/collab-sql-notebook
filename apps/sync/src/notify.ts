/**
 * Events from the API, delivered through Postgres LISTEN/NOTIFY.
 *
 * The API sends a NOTIFY on the `notebook_events` channel inside the same
 * transaction as the change it describes; Postgres delivers it only when that
 * transaction commits, so the server never hears about a change that was
 * rolled back. One dedicated connection listens. If it drops, it reconnects
 * with backoff. Notifications sent while it was down are lost (Postgres
 * doesn't queue them for a listener that isn't connected). After a
 * reconnect, `onReconnect` runs so access can be re-checked against the
 * tables (the server does that for every open socket and loaded room). Run
 * events are not recovered here: a missed run_finished leaves the cell's
 * `running` state set and its new result unpointed (lastRunId unchanged)
 * until something reconciles it from the API's tables.
 *
 * Payloads come from the database, but they're validated like any other
 * input: a malformed one is logged and ignored, and an unknown `type` is
 * ignored silently so the API can add event types before this server knows
 * them.
 */
import pg from "pg";

import { errorMessage, log } from "./log.ts";
import { UUID_PATTERN } from "./ticket.ts";

export const CHANNEL = "notebook_events";

export type NotebookEvent =
  | {
      type: "run_started";
      notebookId: string;
      cellId: string;
      executionId: string;
      userName: string;
      startedAt: string;
    }
  | {
      type: "run_finished";
      notebookId: string;
      cellId: string;
      executionId: string;
      runId: string | null;
    }
  | { type: "access_changed"; notebookId: string; userId: string }
  | { type: "notebook_deleted"; notebookId: string };

// The API accepts only these cell IDs (they also live in the document).
const CELL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EXECUTION_ID = /^[A-Za-z0-9_-]{1,128}$/;
// Same cap as users.name, in code points (see ticket.ts).
const MAX_NAME_LENGTH = 200;
const MAX_TIMESTAMP_LENGTH = 64;

class InvalidEvent extends Error {}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.toLowerCase())) {
    throw new InvalidEvent(`${field} is not a UUID`);
  }
  return value.toLowerCase();
}

function matching(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new InvalidEvent(`bad ${field}`);
  return value;
}

/**
 * The event in `payload`, or null if it should be ignored (unknown type).
 * Throws InvalidEvent if a known event is malformed.
 */
function toEvent(raw: Record<string, unknown>): NotebookEvent | null {
  switch (raw.type) {
    case "run_started": {
      const userName = raw.user_name;
      const startedAt = raw.started_at;
      if (typeof userName !== "string" || [...userName].length > MAX_NAME_LENGTH) {
        throw new InvalidEvent("bad user_name");
      }
      if (
        typeof startedAt !== "string" ||
        startedAt.length > MAX_TIMESTAMP_LENGTH ||
        Number.isNaN(Date.parse(startedAt))
      ) {
        throw new InvalidEvent("bad started_at");
      }
      return {
        type: "run_started",
        notebookId: uuid(raw.notebook_id, "notebook_id"),
        cellId: matching(raw.cell_id, CELL_ID, "cell_id"),
        executionId: matching(raw.execution_id, EXECUTION_ID, "execution_id"),
        userName,
        startedAt,
      };
    }
    case "run_finished":
      return {
        type: "run_finished",
        notebookId: uuid(raw.notebook_id, "notebook_id"),
        cellId: matching(raw.cell_id, CELL_ID, "cell_id"),
        executionId: matching(raw.execution_id, EXECUTION_ID, "execution_id"),
        runId: raw.run_id === null ? null : uuid(raw.run_id, "run_id"),
      };
    case "access_changed":
      return {
        type: "access_changed",
        notebookId: uuid(raw.notebook_id, "notebook_id"),
        userId: uuid(raw.user_id, "user_id"),
      };
    case "notebook_deleted":
      return { type: "notebook_deleted", notebookId: uuid(raw.notebook_id, "notebook_id") };
    default:
      return null;
  }
}

/** Parses a NOTIFY payload. Null for anything to ignore; malformed payloads are logged. */
export function parseEvent(payload: string | undefined): NotebookEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload ?? "");
  } catch {
    log.warn("notify.malformed", { why: "not JSON" });
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    log.warn("notify.malformed", { why: "not an object" });
    return null;
  }
  try {
    return toEvent(raw as Record<string, unknown>);
  } catch (error) {
    log.warn("notify.malformed", {
      type: String((raw as { type?: unknown }).type),
      why: errorMessage(error),
    });
    return null;
  }
}

export interface ListenerTimings {
  retryBaseMs: number;
  retryMaxMs: number;
}

/** Keeps one connection LISTENing on the channel, reconnecting when it drops. */
export class NotifyListener {
  private client: pg.Client | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay = 0;
  private stopped = false;
  /** Resolves when the first LISTEN succeeds (tests wait on it). */
  readonly listening: Promise<void>;
  private resolveListening!: () => void;

  private readonly connectionString: string;
  private readonly onEvent: (event: NotebookEvent) => void;
  private readonly timings: ListenerTimings;

  private readonly onReconnect: () => void;
  private listenedBefore = false;

  constructor(
    connectionString: string,
    onEvent: (event: NotebookEvent) => void,
    timings: ListenerTimings = { retryBaseMs: 500, retryMaxMs: 30_000 },
    /** Called each time LISTEN succeeds again after the connection dropped. */
    onReconnect: () => void = () => {},
  ) {
    this.connectionString = connectionString;
    this.onEvent = onEvent;
    this.timings = timings;
    this.onReconnect = onReconnect;
    this.listening = new Promise((resolve) => (this.resolveListening = resolve));
  }

  start(): void {
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.connectionString });
    this.client = client;
    let dropped = false;
    const drop = (error?: unknown) => {
      if (dropped) return;
      dropped = true;
      if (this.client === client) this.client = null;
      client.removeAllListeners("notification");
      client.end().catch(() => {});
      if (this.stopped) return;
      this.retryDelay = Math.min(
        this.retryDelay ? this.retryDelay * 2 : this.timings.retryBaseMs,
        this.timings.retryMaxMs,
      );
      log.warn("notify.disconnected", {
        retryMs: this.retryDelay,
        error: error === undefined ? undefined : errorMessage(error),
      });
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.connect();
      }, this.retryDelay);
    };
    client.on("error", drop);
    client.on("end", () => drop());
    client.on("notification", (message) => {
      if (message.channel !== CHANNEL) return;
      const event = parseEvent(message.payload);
      if (!event) return;
      try {
        this.onEvent(event);
      } catch (error) {
        log.error("notify.handler_failed", { type: event.type, error: errorMessage(error) });
      }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (error) {
      drop(error);
      return;
    }
    if (this.stopped) {
      await client.end().catch(() => {});
      return;
    }
    this.retryDelay = 0;
    log.info("notify.listening", { channel: CHANNEL });
    this.resolveListening();
    if (this.listenedBefore) {
      try {
        this.onReconnect();
      } catch (error) {
        log.error("notify.reconnect_handler_failed", { error: errorMessage(error) });
      }
    }
    this.listenedBefore = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => {});
  }

  /** For tests: the current connection's backend process ID, to terminate it. */
  async backendPid(): Promise<number | null> {
    const client = this.client;
    if (!client) return null;
    const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    return result.rows[0]?.pid ?? null;
  }
}
