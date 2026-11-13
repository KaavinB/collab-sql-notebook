/** Awareness (presence, cursors) through the server: identity, ownership, cleanup. */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { colorFor } from "../src/awareness.ts";
import {
  closeClient,
  connectClient,
  createNotebook,
  member,
  newPool,
  rawSocket,
  sleep,
  settled,
  startServer,
  synced,
  ticketFor,
  truncate,
  waitFor,
  type Client,
  type RunningServer,
} from "./helpers.ts";

let pool: pg.Pool;
let s: RunningServer;
const clients: Client[] = [];

beforeAll(async () => {
  pool = newPool();
  s = await startServer({ pool });
});

afterAll(async () => {
  await s.sync.stop();
  await pool.end();
});

beforeEach(async () => {
  await truncate(pool);
});

afterEach(async () => {
  for (const c of clients.splice(0)) closeClient(c);
  await settled(s);
});

function client(notebookId: string, ticket: string): Client {
  const c = connectClient(s, notebookId, ticket);
  clients.push(c);
  return c;
}

function stateOf(observer: Client, of: Client): Record<string, unknown> | undefined {
  return observer.provider.awareness.getStates().get(of.doc.clientID) as
    Record<string, unknown> | undefined;
}

function awarenessFrame(clientId: number, clock: number, state: unknown): Uint8Array {
  const update = encoding.createEncoder();
  encoding.writeVarUint(update, 1);
  encoding.writeVarUint(update, clientId);
  encoding.writeVarUint(update, clock);
  encoding.writeVarString(update, JSON.stringify(state));
  const message = encoding.createEncoder();
  encoding.writeVarUint(message, 1); // awareness
  encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
  return encoding.toUint8Array(message);
}

describe("presence", () => {
  it("replaces a spoofed user with the identity from the ticket", async () => {
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor", "Alice");
    const bob = await member(pool, nb, "editor", "Bob");
    const a = client(nb, ticketFor(alice, nb));
    const b = client(nb, ticketFor(bob, nb));
    await Promise.all([synced(a), synced(b)]);

    a.provider.awareness.setLocalState({
      user: { id: bob.userId, name: "Bob", color: "#000000" },
      marker: { anchor: 1, head: 2 },
    });
    await waitFor(() => stateOf(b, a)?.marker !== undefined, "Bob to see Alice's state");
    expect(stateOf(b, a)).toEqual({
      user: { id: alice.userId, name: "Alice", color: colorFor(alice.userId) },
      marker: { anchor: 1, head: 2 },
    });
  });

  it("relays viewers' presence", async () => {
    const nb = await createNotebook(pool);
    const editor = await member(pool, nb, "editor");
    const viewer = await member(pool, nb, "viewer", "Vera");
    const e = client(nb, ticketFor(editor, nb));
    const v = client(nb, ticketFor(viewer, nb));
    await Promise.all([synced(e), synced(v)]);
    v.provider.awareness.setLocalStateField("marker", { anchor: 3 });
    await waitFor(() => stateOf(e, v)?.marker !== undefined, "viewer presence");
    expect((stateOf(e, v)!.user as { name: string }).name).toBe("Vera");
  });

  it("drops updates for a clientID another connection owns", async () => {
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor", "Alice");
    const bob = await member(pool, nb, "editor", "Bob");
    const mallory = await member(pool, nb, "editor", "Mallory");
    const a = client(nb, ticketFor(alice, nb));
    const b = client(nb, ticketFor(bob, nb));
    await Promise.all([synced(a), synced(b)]);
    a.provider.awareness.setLocalStateField("marker", "alice's");
    await waitFor(() => stateOf(b, a)?.marker === "alice's", "Alice's state");

    // Mallory announces Alice's clientID with a far-future clock, then her own.
    const malloryId = 123456;
    const socket = rawSocket(`${s.url}/notebooks/${nb}?ticket=${ticketFor(mallory, nb)}`, {
      onOpen: (ws) => {
        ws.send(awarenessFrame(a.doc.clientID, 1_000_000, { marker: "hijacked" }));
        ws.send(awarenessFrame(malloryId, 1, { marker: "mallory's" }));
      },
    });
    await waitFor(() => b.provider.awareness.getStates().has(malloryId), "Mallory's own state");
    expect(stateOf(b, a)?.marker).toBe("alice's");
    expect((b.provider.awareness.getStates().get(malloryId)!.user as { name: string }).name).toBe(
      "Mallory",
    );
    socket.ws.close();
    await socket;
  });

  // "early": the tab announces itself before the server has opened its
  // connection (queued); "late": only after receiving the presence list.
  it.each(["early", "late"])(
    "lets a reconnecting tab take over its clientID while its old socket lingers (%s)",
    async (timing) => {
      const nb = await createNotebook(pool);
      const alice = await member(pool, nb, "editor", "Alice");
      const bob = await member(pool, nb, "editor", "Bob");
      const b = client(nb, ticketFor(bob, nb));
      await synced(b);
      const tabId = 4242;
      const target = `${s.url}/notebooks/${nb}?ticket=`;
      const markerOf = () => b.provider.awareness.getStates().get(tabId)?.marker;
      const old = rawSocket(target + ticketFor(alice, nb), {
        onOpen: (ws) => ws.send(awarenessFrame(tabId, 3, { marker: "old" })),
      });
      await waitFor(() => markerOf() === "old", "old socket's presence");

      // The network dropped; the server hasn't noticed the old socket is dead.
      // Clocks the new socket receives for its own clientID. Anything but its
      // own clock (3) would overwrite the tab's local state with a stale copy.
      const ownClocks: number[] = [];
      const announce = awarenessFrame(tabId, 3, { marker: "new" });
      let announced = false;
      const fresh = rawSocket(target + ticketFor(alice, nb), {
        onOpen: (ws) => {
          ws.on("message", (data: Buffer) => {
            const decoder = decoding.createDecoder(new Uint8Array(data));
            if (decoding.readVarUint(decoder) !== 1) return;
            const update = decoding.createDecoder(decoding.readVarUint8Array(decoder));
            const count = decoding.readVarUint(update);
            for (let i = 0; i < count; i++) {
              const id = decoding.readVarUint(update);
              const clock = decoding.readVarUint(update);
              decoding.readVarString(update);
              if (id === tabId) ownClocks.push(clock);
            }
            if (!announced) {
              announced = true;
              ws.send(announce); // late: right after the presence list
            }
          });
          if (timing === "early") {
            announced = true;
            ws.send(announce);
          }
        },
      });
      await waitFor(() => markerOf() === "new", "new socket's presence");
      await waitFor(() => ownClocks.length > 0, "the echo of its own state");
      expect(new Set(ownClocks)).toEqual(new Set([3]));

      // When the old socket finally goes, the presence stays.
      old.ws.close();
      await old;
      await sleep(50);
      expect(markerOf()).toBe("new");
      fresh.ws.close();
      await fresh;
      await waitFor(() => markerOf() === undefined, "removal with the new socket");
    },
  );

  it("removes a client's presence when it disconnects and restores it on reconnect", async () => {
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor");
    const bob = await member(pool, nb, "editor");
    const a = client(nb, ticketFor(alice, nb));
    const b = client(nb, ticketFor(bob, nb));
    await Promise.all([synced(a), synced(b)]);
    a.provider.awareness.setLocalStateField("marker", 1);
    await waitFor(() => stateOf(b, a) !== undefined, "presence");

    a.provider.disconnect();
    await waitFor(() => stateOf(b, a) === undefined, "presence removed");

    // Reconnecting with the same awareness clock must show up at once, not
    // after the client's next 15-second renewal.
    a.provider.connect();
    await synced(a);
    await waitFor(() => stateOf(b, a) !== undefined, "presence back", 2000);
  });

  it("shows a reconnecting client its idle peers at once", async () => {
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor");
    const bob = await member(pool, nb, "editor");
    const a = client(nb, ticketFor(alice, nb));
    const b = client(nb, ticketFor(bob, nb));
    await Promise.all([synced(a), synced(b)]);
    b.provider.awareness.setLocalStateField("marker", "bob's");
    await waitFor(() => stateOf(a, b)?.marker === "bob's", "Bob's presence");

    // Alice drops Bob's state on disconnect but keeps his clock; Bob stays
    // idle, so only the server's presence list can bring him back.
    a.provider.disconnect();
    await waitFor(() => stateOf(a, b) === undefined, "Bob gone on Alice's side");
    a.provider.connect();
    await synced(a);
    await waitFor(() => stateOf(a, b)?.marker === "bob's", "Bob back for Alice", 1000);
  });

  it("gives a joining client everyone's presence", async () => {
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor");
    const bob = await member(pool, nb, "editor");
    const a = client(nb, ticketFor(alice, nb));
    await synced(a);
    a.provider.awareness.setLocalStateField("marker", 7);
    await sleep(50);
    const b = client(nb, ticketFor(bob, nb));
    await synced(b);
    await waitFor(() => stateOf(b, a)?.marker === 7, "existing presence");
  });
});
