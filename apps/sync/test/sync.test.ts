/** End-to-end sync through a real server, real y-websocket clients and real Postgres. */
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  closeClient,
  connectClient,
  createNotebook,
  logRows,
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
const servers: RunningServer[] = [];
const clients: Client[] = [];

async function server(options: Parameters<typeof startServer>[0] = {}): Promise<RunningServer> {
  const s = await startServer({ pool, ...options });
  servers.push(s);
  return s;
}

function client(s: RunningServer, notebookId: string, ticket: string, doc?: Y.Doc): Client {
  const c = connectClient(s, notebookId, ticket, doc);
  clients.push(c);
  return c;
}

function text(c: Client | Y.Doc): string {
  const doc = c instanceof Y.Doc ? c : c.doc;
  return doc.getText("t").toString();
}

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

describe("sync", () => {
  it("converges two clients editing concurrently", async () => {
    const s = await server();
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor");
    const bob = await member(pool, nb, "owner");
    const a = client(s, nb, ticketFor(alice, nb));
    const b = client(s, nb, ticketFor(bob, nb));
    await Promise.all([synced(a), synced(b)]);

    // Interleaved edits on both sides before either sees the other's.
    for (let i = 0; i < 20; i++) {
      a.doc.getText("t").insert(0, "a");
      b.doc.getText("t").insert(b.doc.getText("t").length, "b");
    }
    await waitFor(() => text(a).length === 40 && text(b).length === 40, "both to see 40 chars");
    expect(text(a)).toBe(text(b));
    const room = s.sync.manager.rooms.get(nb)!;
    expect(room.doc.getText("t").toString()).toBe(text(a));
  });

  it("gives a late joiner the whole document", async () => {
    const s = await server();
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor");
    const a = client(s, nb, ticketFor(alice, nb));
    await synced(a);
    a.doc.getText("t").insert(0, "hello world");
    await waitFor(() => s.sync.manager.rooms.get(nb)?.doc.getText("t").length === 11, "server");

    const carol = await member(pool, nb, "editor");
    const c = client(s, nb, ticketFor(carol, nb));
    await synced(c);
    expect(text(c)).toBe("hello world");
  });

  it("merges a client's offline edits when it connects", async () => {
    const s = await server();
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor");
    const bob = await member(pool, nb, "editor");
    const a = client(s, nb, ticketFor(alice, nb));
    await synced(a);
    a.doc.getText("t").insert(0, "online");

    // Bob edited before connecting; the server asks for his changes (step 1).
    const offline = new Y.Doc();
    offline.getText("t").insert(0, "offline ");
    const b = client(s, nb, ticketFor(bob, nb), offline);
    await synced(b);
    await waitFor(() => text(a).length === 14 && text(b).length === 14, "merge");
    expect(text(a)).toBe(text(b));
  });

  it("has a client's offline edits even if it closes the moment it's synced", async () => {
    // Browsers keep a page's connection open after the page is gone only
    // until it's synced, then close it. That's safe only because the server
    // asks for the client's edits (step 1) before sending its own state
    // (step 2, which the client takes as "synced"): the edits are already
    // on their way when it closes.
    const s = await server();
    const nb = await createNotebook(pool);
    const bob = await member(pool, nb, "editor");
    const offline = new Y.Doc();
    offline.getText("t").insert(0, "typed offline");
    const b = client(s, nb, ticketFor(bob, nb), offline);
    b.provider.on("sync", (isSynced: boolean) => {
      if (isSynced) b.provider.destroy();
    });
    await waitFor(
      () => s.sync.manager.rooms.get(nb)?.doc.getText("t").toString() === "typed offline",
      "the offline edit on the server",
    );
  });

  it("restores the document after a restart", async () => {
    // A long flush interval: the edit is only saved by the shutdown flush.
    const first = await server({ timings: { flushIntervalMs: 60_000 } });
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor");
    const a = client(first, nb, ticketFor(alice, nb));
    await synced(a);
    a.doc.getText("t").insert(0, "survives");
    await waitFor(() => first.sync.manager.rooms.get(nb)?.doc.getText("t").length === 8, "server");
    closeClient(clients.pop()!);
    await first.sync.stop();
    servers.splice(servers.indexOf(first), 1);

    const second = await server();
    const fresh = client(second, nb, ticketFor(alice, nb));
    await synced(fresh);
    expect(text(fresh)).toBe("survives");
  });

  it("appends batches to the log, then compacts into one snapshot when the room empties", async () => {
    const s = await server({ timings: { unloadGraceMs: 300 } });
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor");
    const a = client(s, nb, ticketFor(alice, nb));
    await synced(a);
    for (let i = 0; i < 5; i++) {
      a.doc.getText("t").insert(0, `${i}`);
      await new Promise((resolve) => setTimeout(resolve, 40)); // > flush interval: separate rows
    }
    await waitFor(async () => (await logRows(pool, nb)) >= 2, "several log rows");
    const expected = Y.encodeStateAsUpdate(a.doc);

    closeClient(clients.pop()!);
    await waitFor(() => !s.sync.manager.rooms.has(nb), "room to unload");
    expect(await logRows(pool, nb)).toBe(0);
    const snapshots = await pool.query(
      "SELECT state FROM notebook_snapshots WHERE notebook_id = $1",
      [nb],
    );
    expect(snapshots.rowCount).toBe(1);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, snapshots.rows[0].state);
    expect(text(restored)).toBe("43210");
    const original = new Y.Doc();
    Y.applyUpdate(original, expected);
    expect(restored.getText("t").toJSON()).toEqual(original.getText("t").toJSON());
  });

  it("compacts a busy room once the log passes its row limit", async () => {
    const s = await server({ timings: { compactAfterRows: 3 } });
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor");
    const a = client(s, nb, ticketFor(alice, nb));
    await synced(a);
    for (let i = 0; i < 4; i++) {
      a.doc.getText("t").insert(0, "x");
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await waitFor(async () => {
      const snapshot = await pool.query("SELECT 1 FROM notebook_snapshots WHERE notebook_id = $1", [
        nb,
      ]);
      return snapshot.rowCount === 1;
    }, "a snapshot while the room is open");
    expect(s.sync.manager.rooms.has(nb)).toBe(true);
    await waitFor(async () => text(await storedDoc(pool, nb)) === "xxxx", "stored doc complete");
    expect(await logRows(pool, nb)).toBeLessThan(3);
  });

  it("keeps an empty room through the grace period when the client comes back", async () => {
    const s = await server({ timings: { unloadGraceMs: 500 } });
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor");
    const a = client(s, nb, ticketFor(alice, nb));
    await synced(a);
    const room = s.sync.manager.rooms.get(nb);
    closeClient(clients.pop()!);
    await waitFor(() => room!.conns.size === 0, "disconnect");
    const again = client(s, nb, ticketFor(alice, nb));
    await synced(again);
    expect(s.sync.manager.rooms.get(nb)).toBe(room);
  });
});

describe("viewers", () => {
  it("drops a viewer's edits but still sends them everyone else's", async () => {
    const s = await server();
    const nb = await createNotebook(pool);
    const editor = await member(pool, nb, "editor");
    const viewer = await member(pool, nb, "viewer");
    const e = client(s, nb, ticketFor(editor, nb));
    const v = client(s, nb, ticketFor(viewer, nb));
    await Promise.all([synced(e), synced(v)]);

    e.doc.getText("t").insert(0, "from editor");
    await waitFor(() => text(v) === "from editor", "viewer to receive the edit");

    v.doc.getText("t").insert(0, "VIEWER ");
    // Followed by an editor edit: once that arrives everywhere, the viewer's
    // earlier message has been handled too (one socket, in order).
    await new Promise((resolve) => setTimeout(resolve, 50));
    e.doc.getText("t").insert(e.doc.getText("t").length, "!");
    await waitFor(() => text(v).endsWith("!"), "viewer to receive the second edit");

    const room = s.sync.manager.rooms.get(nb)!;
    expect(room.doc.getText("t").toString()).toBe("from editor!");
    expect(text(e)).toBe("from editor!");
    await room.flushAll();
    expect(text(await storedDoc(pool, nb))).toBe("from editor!");
  });
});
