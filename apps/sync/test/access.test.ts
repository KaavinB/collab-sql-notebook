/** Who may connect, and how bad input is refused (HTTP statuses and close codes). */
import { randomUUID } from "node:crypto";

import * as encoding from "lib0/encoding";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { MAX_MESSAGE_BYTES } from "../src/server.ts";
import { signTicket } from "../src/ticket.ts";
import {
  closeClient,
  connectClient,
  createNotebook,
  member,
  newPool,
  rawSocket,
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

function url(notebookId: string, ticket?: string): string {
  const base = `${s.url}/notebooks/${notebookId}`;
  return ticket === undefined ? base : `${base}?ticket=${encodeURIComponent(ticket)}`;
}

/** A raw socket that sends `frames` as soon as it opens. */
function sendOnOpen(target: string, frames: Array<Uint8Array | string>) {
  return rawSocket(target, {
    onOpen: (ws) => {
      for (const frame of frames) ws.send(frame);
    },
  });
}

describe("HTTP", () => {
  it("answers /health", async () => {
    const response = await fetch(`http://127.0.0.1:${s.port}/health`);
    expect(response.status).toBe(200);
  });

  it("answers 404 to other requests and upgrades", async () => {
    expect((await fetch(`http://127.0.0.1:${s.port}/notebooks`)).status).toBe(404);
    expect(await rawSocket(`${s.url}/other`)).toEqual({ status: 404 });
    expect(await rawSocket(`${s.url}/notebooks/not-a-uuid?ticket=x`)).toEqual({ status: 404 });
    expect(await rawSocket(`${s.url}/notebooks/${randomUUID()}/x`)).toEqual({ status: 404 });
  });

  it("refuses a foreign or missing Origin before upgrading", async () => {
    const nb = await createNotebook(pool);
    const editor = await member(pool, nb, "editor");
    const ticket = ticketFor(editor, nb);
    expect(await rawSocket(url(nb, ticket), { origin: "https://evil.example" })).toEqual({
      status: 403,
    });
    expect(await rawSocket(url(nb, ticket), { origin: null })).toEqual({ status: 403 });
  });
});

describe("tickets", () => {
  it("closes with 4401 for a missing, forged, expired or misdirected ticket", async () => {
    const nb = await createNotebook(pool);
    const other = await createNotebook(pool);
    const editor = await member(pool, nb, "editor");
    const now = Math.floor(Date.now() / 1000);
    const forged = signTicket(
      { userId: editor.userId, name: editor.name, notebookId: nb, role: "editor" },
      Buffer.from("some-other-secret-at-least-32-characters"),
      now + 60,
    );
    const cases = {
      missing: url(nb),
      garbage: url(nb, "not.a-ticket"),
      forged: url(nb, forged),
      expired: url(nb, ticketFor(editor, nb, now - 1)),
      otherNotebook: url(other, ticketFor(editor, nb)),
      twoTickets: `${url(nb, ticketFor(editor, nb))}&ticket=${ticketFor(editor, nb)}`,
    };
    for (const [name, target] of Object.entries(cases)) {
      expect({ name, ...(await rawSocket(target)) }).toEqual({ name, closeCode: 4401 });
    }
  });

  it("closes with 4403 when the user isn't a member or their role changed", async () => {
    const nb = await createNotebook(pool);
    const outsider = { userId: randomUUID(), name: "Outsider", role: "editor" as const };
    expect(await rawSocket(url(nb, ticketFor(outsider, nb)))).toEqual({ closeCode: 4403 });

    // The ticket says editor, but the user was made a viewer since.
    const demoted = await member(pool, nb, "viewer");
    const stale = ticketFor({ ...demoted, role: "editor" }, nb);
    expect(await rawSocket(url(nb, stale))).toEqual({ closeCode: 4403 });
  });

  it("closes with 4404 when the notebook doesn't exist", async () => {
    const editor = { userId: randomUUID(), name: "Ed", role: "editor" as const };
    const nb = randomUUID();
    expect(await rawSocket(url(nb, ticketFor(editor, nb)))).toEqual({ closeCode: 4404 });
  });
});

describe("bad messages", () => {
  async function editorUrl(): Promise<{ nb: string; target: string }> {
    const nb = await createNotebook(pool);
    const editor = await member(pool, nb, "editor");
    return { nb, target: url(nb, ticketFor(editor, nb)) };
  }

  it("closes with 4413 when a message is over the size limit", async () => {
    const { target } = await editorUrl();
    const big = new Uint8Array(MAX_MESSAGE_BYTES + 1);
    expect(await sendOnOpen(target, [big])).toEqual({ closeCode: 4413 });
  });

  it("closes with 4400 for garbage, text frames and unknown message types", async () => {
    const { target } = await editorUrl();
    expect(await sendOnOpen(target, [new Uint8Array([0xff, 0xff, 0xff])])).toEqual({
      closeCode: 4400,
    });
    expect(await sendOnOpen(target, ["hello"])).toEqual({ closeCode: 4400 });
    expect(await sendOnOpen(target, [new Uint8Array([9])])).toEqual({ closeCode: 4400 });
    // A sync message with trailing bytes.
    expect(await sendOnOpen(target, [new Uint8Array([0, 0, 0, 7])])).toEqual({ closeCode: 4400 });
  });

  it("closes with 4400 for an update Yjs can't decode, without touching the room", async () => {
    const { nb } = await editorUrl();
    const alice = await member(pool, nb, "editor");
    const a = connectClient(s, nb, ticketFor(alice, nb));
    clients.push(a);
    await synced(a);
    a.doc.getText("t").insert(0, "intact");
    await waitFor(() => s.sync.manager.rooms.get(nb)?.doc.getText("t").length === 6, "server");

    const mallory = await member(pool, nb, "editor");
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0); // sync
    encoding.writeVarUint(encoder, 2); // update
    encoding.writeVarUint8Array(encoder, new Uint8Array([5, 200, 1, 2, 3, 4, 5, 6, 7]));
    const result = await sendOnOpen(url(nb, ticketFor(mallory, nb)), [
      encoding.toUint8Array(encoder),
    ]);
    expect(result).toEqual({ closeCode: 4400 });

    // The room still works for everyone else.
    const bob = await member(pool, nb, "editor");
    const b = connectClient(s, nb, ticketFor(bob, nb));
    clients.push(b);
    await synced(b);
    expect(b.doc.getText("t").toString()).toBe("intact");
    a.doc.getText("t").insert(6, "!");
    await waitFor(() => b.doc.getText("t").toString() === "intact!", "later edits");
  });

  it("closes with 4400 when updates with missing dependencies pile up", async () => {
    const { nb, target } = await editorUrl();
    // Someone else keeps the room loaded and must not be affected.
    const alice = await member(pool, nb, "editor");
    const a = connectClient(s, nb, ticketFor(alice, nb));
    clients.push(a);
    await synced(a);
    const frames: Uint8Array[] = [];
    for (let i = 0; i < 2; i++) {
      // An update that builds on one the server never gets.
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "never sent");
      const before = Y.encodeStateVector(doc);
      doc.getText("t").insert(10, "x".repeat(1_500_000));
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      encoding.writeVarUint(encoder, 2);
      encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(doc, before));
      frames.push(encoding.toUint8Array(encoder));
    }
    expect(await sendOnOpen(target, frames)).toEqual({ closeCode: 4400 });
    const room = s.sync.manager.rooms.get(nb)!;
    expect(room.doc.store.pendingStructs).toBeNull();
    expect(room.doc.getText("t").length).toBe(0);
    a.doc.getText("t").insert(0, "still fine");
    await waitFor(() => room.doc.getText("t").toString() === "still fine", "room works");
  });

  it("queues messages sent before the room loaded and applies them in order", async () => {
    // A valid update sent in the same breath as opening: it arrives while
    // the connection is still pending and must still be applied.
    const { nb, target } = await editorUrl();
    const local = new Y.Doc();
    local.getText("t").insert(0, "early");
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    encoding.writeVarUint(encoder, 2);
    encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(local));
    const socket = sendOnOpen(target, [encoding.toUint8Array(encoder)]);
    await waitFor(
      () => s.sync.manager.rooms.get(nb)?.doc.getText("t").toString() === "early",
      "early update applied",
    );
    socket.ws.close();
    await socket;
  });
});
