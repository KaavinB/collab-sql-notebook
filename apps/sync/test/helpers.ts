/** Shared setup for the integration tests: database rows, servers, clients. */
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import pg from "pg";
import { inject } from "vitest";
import WebSocket from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import type { Config } from "../src/config.ts";
import { setQuiet } from "../src/log.ts";
import type { ManagerTimings } from "../src/rooms.ts";
import { createSyncServer, type SyncServer, type SyncServerOptions } from "../src/server.ts";
import { signTicket, type Role } from "../src/ticket.ts";

setQuiet(true);

export const ORIGIN = "http://localhost:3000";
export const SECRET = Buffer.from("test-secret-that-is-at-least-32-characters-long");

export function databaseUrl(): string {
  return inject("databaseUrl");
}

export function newPool(): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl(), max: 5 });
}

/** Empties every table the tests write (everything hangs off notebooks and users). */
export async function truncate(pool: pg.Pool): Promise<void> {
  await pool.query("TRUNCATE notebooks, users CASCADE");
}

export async function createUser(pool: pg.Pool, name: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO users (id, name) VALUES ($1, $2)", [id, name]);
  return id;
}

export async function createNotebook(pool: pg.Pool, state?: Uint8Array): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO notebooks (id, title) VALUES ($1, 'Test')", [id]);
  if (state) {
    await pool.query("INSERT INTO notebook_snapshots (notebook_id, state) VALUES ($1, $2)", [
      id,
      Buffer.from(state),
    ]);
  }
  return id;
}

export async function addMember(
  pool: pg.Pool,
  notebookId: string,
  userId: string,
  role: Role,
): Promise<void> {
  await pool.query(
    "INSERT INTO notebook_members (notebook_id, user_id, role) VALUES ($1, $2, $3)",
    [notebookId, userId, role],
  );
}

export interface Member {
  userId: string;
  name: string;
  role: Role;
}

/** A user who is a member of `notebookId` with `role`. */
export async function member(
  pool: pg.Pool,
  notebookId: string,
  role: Role,
  name = `${role} ${Math.random().toString(36).slice(2, 6)}`,
): Promise<Member> {
  const userId = await createUser(pool, name);
  await addMember(pool, notebookId, userId, role);
  return { userId, name, role };
}

export function ticketFor(who: Member, notebookId: string, expSeconds?: number): string {
  return signTicket(
    { userId: who.userId, name: who.name, notebookId, role: who.role },
    SECRET,
    expSeconds ?? Math.floor(Date.now() / 1000) + 60,
  );
}

/** Short timings so tests don't wait for production intervals. */
export const FAST_TIMINGS: Partial<ManagerTimings> = {
  flushIntervalMs: 20,
  unloadGraceMs: 50,
  unloadRetryMs: 50,
  retryBaseMs: 20,
  retryMaxMs: 100,
};

export interface RunningServer {
  sync: SyncServer;
  url: string;
  port: number;
}

export async function startServer(
  options: Partial<Omit<SyncServerOptions, "config">> & { config?: Partial<Config> } = {},
): Promise<RunningServer> {
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    ticketSecret: SECRET,
    allowedOrigins: new Set([ORIGIN]),
    databaseUrl: databaseUrl(),
    ...options.config,
  };
  const sync = createSyncServer({
    listen: false,
    ...options,
    timings: { ...FAST_TIMINGS, ...options.timings },
    config,
  });
  const address: AddressInfo = await sync.start();
  return { sync, url: `ws://127.0.0.1:${address.port}`, port: address.port };
}

/** A ws client that sends the allowed Origin, as a browser on the web app would. */
export class BrowserLikeWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols, { origin: ORIGIN });
  }
}

export interface Client {
  doc: Y.Doc;
  provider: WebsocketProvider;
}

/**
 * A real y-websocket client, configured like the browser will be except for
 * the WebSocket class. BroadcastChannel is off: in one process every
 * provider would otherwise sync through it and bypass the server.
 */
export function connectClient(
  server: RunningServer,
  notebookId: string,
  ticket: string,
  doc: Y.Doc = new Y.Doc(),
): Client {
  const provider = new WebsocketProvider(`${server.url}/notebooks`, notebookId, doc, {
    params: { ticket },
    WebSocketPolyfill: BrowserLikeWebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
    // A test that wants reconnects makes a new client; retries would only
    // hide failures.
    shouldReconnect: () => false,
  });
  return { doc, provider };
}

export function synced(client: Client): Promise<void> {
  if (client.provider.synced) return Promise.resolve();
  return new Promise((resolve) => {
    const onSync = (isSynced: boolean) => {
      if (!isSynced) return;
      client.provider.off("sync", onSync);
      resolve();
    };
    client.provider.on("sync", onSync);
  });
}

export function closeClient(client: Client): void {
  client.provider.destroy();
  client.doc.destroy();
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what = "condition",
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Waits until the server has saved and unloaded every room. Tests that share
 * a server call this before the next test truncates the tables: a room still
 * compacting holds row locks that TRUNCATE would deadlock with.
 */
export async function settled(server: RunningServer): Promise<void> {
  await waitFor(() => server.sync.manager.rooms.size === 0, "every room to unload");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RawResult {
  /** HTTP status if the upgrade was refused. */
  status?: number;
  /** Close code if the socket opened and was then closed. */
  closeCode?: number;
}

/** Opens a raw socket and resolves with how it ended (refused upgrade or close code). */
export function rawSocket(
  url: string,
  options: { origin?: string | null; onOpen?: (ws: WebSocket) => void } = {},
): Promise<RawResult> & { ws: WebSocket } {
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  const ws = new WebSocket(url, origin === null ? {} : { origin });
  const result = new Promise<RawResult>((resolve) => {
    ws.on("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode });
      ws.terminate();
    });
    ws.on("error", () => {});
    ws.on("open", () => options.onOpen?.(ws));
    ws.on("close", (code) => resolve({ closeCode: code }));
  });
  return Object.assign(result, { ws });
}

export async function logRows(pool: pg.Pool, notebookId: string): Promise<number> {
  const result = await pool.query(
    "SELECT count(*)::int AS n FROM notebook_updates WHERE notebook_id = $1",
    [notebookId],
  );
  return result.rows[0].n as number;
}

/** The stored document (snapshot + log), as a fresh Y.Doc. */
export async function storedDoc(pool: pg.Pool, notebookId: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const snapshot = await pool.query("SELECT state FROM notebook_snapshots WHERE notebook_id = $1", [
    notebookId,
  ]);
  if (snapshot.rows[0]) Y.applyUpdate(doc, snapshot.rows[0].state);
  const log = await pool.query(
    'SELECT "update" FROM notebook_updates WHERE notebook_id = $1 ORDER BY id',
    [notebookId],
  );
  for (const row of log.rows) Y.applyUpdate(doc, row.update);
  return doc;
}

/** A document with one SQL cell, shaped like apps/web/src/lib/notebook/doc.ts writes it. */
export function docWithSqlCell(cellId: string, sql = "SELECT 1"): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const cell = new Y.Map<unknown>();
    cell.set("type", "sql");
    cell.set("order", "a0");
    const source = new Y.Text();
    source.insert(0, sql);
    cell.set("source", source);
    cell.set("lastRunId", null);
    doc.getMap("cells").set(cellId, cell);
  });
  return doc;
}

export function cellOf(doc: Y.Doc, cellId: string): Y.Map<unknown> | undefined {
  return doc.getMap<Y.Map<unknown>>("cells").get(cellId);
}
