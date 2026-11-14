/** Room lifecycle details: shared loads, early messages, failed writes, backpressure. */
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import * as Y from "yjs";

import { Connection, MAX_BUFFERED_BYTES } from "../src/connection.ts";
import { DEFAULT_TIMINGS, Room } from "../src/room.ts";
import { NotebookGoneError, Store, type LoadedDocument } from "../src/store.ts";
import {
  cellOf,
  closeClient,
  connectClient,
  createNotebook,
  docWithSqlCell,
  member,
  newPool,
  startServer,
  storedDoc,
  synced,
  ticketFor,
  truncate,
  waitFor,
  type Client,
  type RunningServer,
} from "./helpers.ts";

let pool: pg.Pool;
const clients: Client[] = [];
const servers: RunningServer[] = [];

beforeAll(() => {
  pool = newPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncate(pool);
});

afterEach(async () => {
  for (const c of clients.splice(0)) closeClient(c);
  for (const s of servers.splice(0)) await s.sync.stop();
});

/** A Store whose loads wait until the test releases them. */
class GatedStore extends Store {
  loads = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => (this.release = resolve));

  open(): void {
    this.release();
  }

  override async load(notebookId: string): Promise<LoadedDocument | null> {
    this.loads++;
    await this.gate;
    return super.load(notebookId);
  }
}

describe("loading", () => {
  it("shares one load between concurrent connections and keeps their early edits", async () => {
    const store = new GatedStore(pool);
    const s = await startServer({ pool, store });
    servers.push(s);
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor");
    const bob = await member(pool, nb, "editor");
    const a = connectClient(s, nb, ticketFor(alice, nb));
    const b = connectClient(s, nb, ticketFor(bob, nb));
    clients.push(a, b);
    await waitFor(() => a.provider.wsconnected && b.provider.wsconnected, "sockets open");

    // Sent while the room is still loading: queued on the server.
    a.doc.getText("t").insert(0, "one ");
    a.doc.getText("t").insert(4, "two");
    expect(store.loads).toBe(1);
    expect(s.sync.manager.rooms.get(nb)?.status).toBe("loading");

    store.open();
    await Promise.all([synced(a), synced(b)]);
    await waitFor(() => b.doc.getText("t").toString() === "one two", "early edits relayed");
    expect(store.loads).toBe(1);
  });
});

/** The minimum of a Store the Room uses, with a scriptable append. */
function fakeStore(append: (update: Uint8Array) => Promise<void>): Store {
  return {
    load: async (): Promise<LoadedDocument> => ({ state: null, logRows: 0 }),
    append: async (_id: string, update: Uint8Array) => append(update),
    compact: async () => ({ mergedRows: 0 }),
  } as unknown as Store;
}

const TEST_TIMINGS = { ...DEFAULT_TIMINGS, flushIntervalMs: 5, retryBaseMs: 5, retryMaxMs: 20 };

describe("writing", () => {
  it("keeps a batch whose write failed and retries it, merged with newer changes", async () => {
    const written: Uint8Array[] = [];
    let failures = 2;
    const store = fakeStore(async (update) => {
      if (failures-- > 0) throw new Error("connection refused");
      written.push(update);
    });
    const room = new Room("nb", store, TEST_TIMINGS, () => {});
    await room.ready;
    room.doc.getText("t").insert(0, "a");
    await new Promise((resolve) => setTimeout(resolve, 8));
    room.doc.getText("t").insert(1, "b");
    await waitFor(() => written.length > 0 && !room.hasUnsaved, "a successful write");
    const doc = new Y.Doc();
    for (const update of written) Y.applyUpdate(doc, update);
    expect(doc.getText("t").toString()).toBe("ab");
  });

  it("writes changes that arrive during a final flush in another round", async () => {
    const written: Uint8Array[] = [];
    let room: Room | null = null;
    const store = fakeStore(async (update) => {
      // A change lands while the first write is in flight.
      if (written.length === 0) room!.doc.getText("t").insert(1, "b");
      written.push(update);
    });
    room = new Room("nb", store, { ...TEST_TIMINGS, flushIntervalMs: 60_000 }, () => {});
    await room.ready;
    room.doc.getText("t").insert(0, "a");
    await room.flushAll();
    expect(room.hasUnsaved).toBe(false);
    expect(written).toHaveLength(2);
    const doc = new Y.Doc();
    for (const update of written) Y.applyUpdate(doc, update);
    expect(doc.getText("t").toString()).toBe("ab");
  });

  it("rejects flushAll when a write fails, keeping the batch", async () => {
    const store = fakeStore(async () => {
      throw new Error("connection refused");
    });
    const room = new Room("nb", store, { ...TEST_TIMINGS, flushIntervalMs: 60_000 }, () => {});
    await room.ready;
    room.doc.getText("t").insert(0, "a");
    await expect(room.flushAll()).rejects.toThrow("write failed");
    expect(room.hasUnsaved).toBe(true);
    room.destroy();
  });

  it("closes the room with 4404 and saves nothing more when the notebook is gone", async () => {
    let attempts = 0;
    const store = fakeStore(async () => {
      attempts++;
      throw new NotebookGoneError();
    });
    let gone = false;
    const room = new Room("nb", store, TEST_TIMINGS, () => (gone = true));
    await room.ready;
    const close = vi.fn();
    const conn = new Connection(
      { readyState: 1, OPEN: 1, bufferedAmount: 0, close, send: vi.fn() } as unknown as WebSocket,
      { userId: "u", name: "U", notebookId: "nb", role: "editor" },
    );
    room.conns.add(conn);
    room.doc.getText("t").insert(0, "x");
    await waitFor(() => gone, "room gone");
    expect(room.status).toBe("deleted");
    expect(close).toHaveBeenCalledWith(4404, "notebook deleted");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(1);
  });

  it("writes everything still pending on shutdown", async () => {
    const s = await startServer({ pool, timings: { flushIntervalMs: 60_000 } });
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor");
    const a = connectClient(s, nb, ticketFor(alice, nb));
    clients.push(a);
    await synced(a);
    a.doc.getText("t").insert(0, "last words");
    await waitFor(() => s.sync.manager.rooms.get(nb)?.doc.getText("t").length === 10, "server");
    await s.sync.stop();
    expect((await storedDoc(pool, nb)).getText("t").toString()).toBe("last words");
  });
});

describe("backpressure", () => {
  it("closes a socket whose unsent data passed the limit instead of buffering more", () => {
    const close = vi.fn();
    const send = vi.fn();
    const ws = { readyState: 1, OPEN: 1, bufferedAmount: 0, close, send };
    const conn = new Connection(ws as unknown as WebSocket, {
      userId: "u",
      name: "U",
      notebookId: "nb",
      role: "editor",
    });
    conn.send(new Uint8Array([1]));
    expect(send).toHaveBeenCalledTimes(1);
    ws.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    conn.send(new Uint8Array([2]));
    expect(send).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(1013, "client is not keeping up");
  });

  it("closes a pending connection that queues too much", () => {
    const close = vi.fn();
    const ws = { readyState: 1, OPEN: 1, bufferedAmount: 0, close, send: vi.fn() };
    const conn = new Connection(ws as unknown as WebSocket, {
      userId: "u",
      name: "U",
      notebookId: "nb",
      role: "editor",
    });
    for (let i = 0; i < 5; i++) conn.receive(new Uint8Array(2 * 1024 * 1024));
    expect(close).toHaveBeenCalledWith(1013, "too many messages before the document loaded");
  });
});

describe("a crash right after a change the server made itself", () => {
  it("leaves a viewer holding that change, which was never saved (known limit)", async () => {
    const nb = await createNotebook(pool, Y.encodeStateAsUpdate(docWithSqlCell("c1")));
    const viewer = await member(pool, nb, "viewer");
    // A long batching interval: nothing is written before the crash.
    const first = await startServer({ pool, timings: { flushIntervalMs: 60_000 } });
    const doc = new Y.Doc();
    const v = connectClient(first, nb, ticketFor(viewer, nb), doc);
    await synced(v);
    first.sync.manager.handleEvent({
      type: "run_started",
      notebookId: nb,
      cellId: "c1",
      executionId: "e1",
      userName: "Ada",
      startedAt: "2026-01-01T00:00:00Z",
      expiresAt: null,
    });
    await waitFor(() => cellOf(doc, "c1")?.get("running") != null, "the viewer to see the run");
    // The process dies: the room's unsaved change goes with it.
    for (const room of first.sync.manager.rooms.values()) room.destroy();
    first.sync.manager.rooms.clear();
    v.provider.destroy();
    await first.sync.stop();

    const second = await startServer({ pool });
    servers.push(second);
    const again = connectClient(second, nb, ticketFor(viewer, nb), doc);
    clients.push(again);
    await synced(again);
    expect(cellOf(await storedDoc(pool, nb), "c1")?.get("running")).toBeUndefined();
    // An editor would send it back when reconnecting. A viewer is never
    // asked for its changes (the server would drop them anyway), so it
    // keeps showing a change nobody else has, until it reloads the page.
    expect(cellOf(doc, "c1")?.get("running")).toMatchObject({ executionId: "e1" });
  });
});
