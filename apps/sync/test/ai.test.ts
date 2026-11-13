/**
 * The AI assistant in the document: its events through real Postgres NOTIFY,
 * suggestions read from ai_suggestions, its presence, and reconciliation
 * when events were missed.
 */
import { randomUUID } from "node:crypto";

import * as encoding from "lib0/encoding";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { AI_CLIENT_ID, AI_USER, STOPPED_MESSAGE } from "../src/ai.ts";
import { isCursor } from "../src/awareness.ts";
import { CHANNEL } from "../src/notify.ts";
import {
  cellOf,
  closeClient,
  connectClient,
  createNotebook,
  createUser,
  docWithSqlCell,
  member,
  newPool,
  rawSocket,
  settled,
  sleep,
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
let s: RunningServer;
const clients: Client[] = [];

beforeAll(async () => {
  pool = newPool();
  s = await startServer({
    pool,
    listen: true,
    listenerTimings: { retryBaseMs: 20, retryMaxMs: 100 },
  });
  await s.sync.listener!.listening;
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

const CELL = "cell-1";
const SQL = "SELECT 1";

async function notify(payload: unknown): Promise<void> {
  await pool.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify(payload)]);
}

async function open(nb: string, role: "editor" | "viewer" = "editor"): Promise<Client> {
  const who = await member(pool, nb, role);
  const c = connectClient(s, nb, ticketFor(who, nb));
  clients.push(c);
  await synced(c);
  return c;
}

async function openNotebook(doc = docWithSqlCell(CELL, SQL)) {
  const nb = await createNotebook(pool, Y.encodeStateAsUpdate(doc));
  return { nb, c: await open(nb) };
}

/** An ai_requests row, as the API stores one when a request starts. */
async function insertRequest(
  nb: string,
  options: { status?: string; userId?: string | null; ageSeconds?: number; cellId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO ai_requests (id, notebook_id, cell_id, user_id, kind, prompt, model, status,
       attempts, input_tokens, output_tokens, created_at)
     VALUES ($1, $2, $3, $4, 'fix', '{}', 'test-model', $5, '[]', 0, 0,
       now() - make_interval(secs => $6))`,
    [
      id,
      nb,
      options.cellId ?? CELL,
      options.userId ?? null,
      options.status ?? "running",
      options.ageSeconds ?? 0,
    ],
  );
  return id;
}

async function insertSuggestion(
  nb: string,
  requestId: string,
  options: { status?: string; cellId?: string; sql?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO ai_suggestions (id, notebook_id, cell_id, request_id, kind, status, sql,
       explanation, base_sql, valid)
     VALUES ($1, $2, $3, $4, 'fix', $5, $6, 'Added the missing FROM.', $7, true)`,
    [
      id,
      nb,
      options.cellId ?? CELL,
      requestId,
      options.status ?? "pending",
      options.sql === undefined ? "SELECT 2" : options.sql,
      SQL,
    ],
  );
  return id;
}

const started = (nb: string, requestId: string, cellId = CELL) => ({
  type: "ai_started",
  notebook_id: nb,
  cell_id: cellId,
  request_id: requestId,
  kind: "fix",
  user_name: "Ada",
});
const suggested = (nb: string, requestId: string, suggestionId: string, cellId = CELL) => ({
  type: "ai_suggestion",
  notebook_id: nb,
  cell_id: cellId,
  request_id: requestId,
  suggestion_id: suggestionId,
});
const failed = (nb: string, requestId: string, message = "The model is unavailable.") => ({
  type: "ai_failed",
  notebook_id: nb,
  cell_id: CELL,
  request_id: requestId,
  message,
});
const resolved = (nb: string, suggestionId: string, decision = "accepted") => ({
  type: "ai_resolved",
  notebook_id: nb,
  cell_id: CELL,
  suggestion_id: suggestionId,
  decision,
});

type Ai = Record<string, unknown> | null | undefined;
const aiOf = (c: Client, cellId = CELL): Ai => cellOf(c.doc, cellId)?.get("ai") as Ai;
const aiPresenceOf = (c: Client) =>
  c.provider.awareness.getStates().get(AI_CLIENT_ID) as Record<string, unknown> | undefined;

/** A doc with the cell already showing `ai` (as stored before events were missed). */
function docWithAi(ai: unknown): Y.Doc {
  const doc = docWithSqlCell(CELL, SQL);
  doc.transact(() => cellOf(doc, CELL)!.set("ai", ai));
  return doc;
}

describe("AI events", () => {
  it("shows the AI thinking, then its suggestion read from the table, then clears it", async () => {
    const { nb, c } = await openNotebook();
    const ada = await createUser(pool, "Ada Lovelace");
    const request = await insertRequest(nb, { userId: ada });
    await notify(started(nb, request));
    await waitFor(() => aiOf(c)?.status === "thinking", "thinking");
    const thinking = aiOf(c)!;
    expect(thinking).toEqual({
      status: "thinking",
      requestId: request,
      kind: "fix",
      by: "Ada",
      startedAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(thinking.startedAt as string))).toBe(false);

    const suggestion = await insertSuggestion(nb, request);
    await notify(suggested(nb, request, suggestion));
    await waitFor(() => aiOf(c)?.status === "suggestion", "suggestion");
    expect(aiOf(c)).toEqual({
      status: "suggestion",
      requestId: request,
      suggestionId: suggestion,
      kind: "fix",
      sql: "SELECT 2",
      explanation: "Added the missing FROM.",
      baseSql: SQL,
      valid: true,
      by: "Ada Lovelace", // the asker's current name, from their account
    });

    // Another suggestion's resolution leaves this one alone.
    await notify(resolved(nb, randomUUID()));
    await notify(resolved(nb, suggestion, "rejected"));
    await waitFor(() => aiOf(c) === null, "cleared");
    // The text is never touched by the server.
    expect(cellOf(c.doc, CELL)!.get("source")!.toString()).toBe(SQL);
  });

  it("shows a failure with its message", async () => {
    const { nb, c } = await openNotebook();
    const request = randomUUID();
    await notify(started(nb, request));
    await waitFor(() => aiOf(c)?.status === "thinking", "thinking");
    await notify(failed(nb, request));
    await waitFor(() => aiOf(c)?.status === "failed", "failed");
    expect(aiOf(c)).toEqual({
      status: "failed",
      requestId: request,
      message: "The model is unavailable.",
    });
  });

  it("never lets another request's outcome replace a request still in flight", async () => {
    const { nb, c } = await openNotebook();
    const current = randomUUID();
    await notify(started(nb, current));
    await waitFor(() => aiOf(c)?.status === "thinking", "thinking");
    await notify(failed(nb, randomUUID(), "an older request"));
    await notify({ ...started(nb, current), user_name: "Grace" }); // marker
    await waitFor(() => aiOf(c)?.by === "Grace", "marker");
    expect(aiOf(c)).toMatchObject({ status: "thinking", requestId: current });
  });

  it("leaves the cell thinking for an unknown suggestion, or one from another cell", async () => {
    const { nb, c } = await openNotebook();
    const request = await insertRequest(nb);
    await notify(started(nb, request));
    await waitFor(() => aiOf(c)?.status === "thinking", "thinking");
    await notify(suggested(nb, request, randomUUID()));
    const elsewhere = await insertSuggestion(nb, request, { cellId: "other-cell" });
    await notify(suggested(nb, request, elsewhere));
    // A suggestion of another notebook is never read for this one.
    const other = await createNotebook(pool);
    const foreign = await insertSuggestion(other, await insertRequest(other));
    await notify(suggested(nb, request, foreign));
    await notify({ ...started(nb, request), user_name: "Grace" }); // marker
    await waitFor(() => aiOf(c)?.by === "Grace", "marker");
    expect(aiOf(c)?.status).toBe("thinking");
  });

  it("settles the thinking state when the suggestion was decided before it could be read", async () => {
    const { nb, c } = await openNotebook();
    const request = await insertRequest(nb);
    await notify(started(nb, request));
    await waitFor(() => aiOf(c)?.status === "thinking", "thinking");
    const suggestion = await insertSuggestion(nb, request, { status: "rejected" });
    await notify(suggested(nb, request, suggestion));
    await notify(resolved(nb, suggestion, "rejected"));
    // Cleared, never shown as a suggestion, and the AI leaves.
    await waitFor(() => aiOf(c) === null, "cleared");
    await waitFor(() => aiPresenceOf(c) === undefined, "AI presence gone");
  });

  it("doesn't let a new request push a pending suggestion out of the document", async () => {
    const { nb, c } = await openNotebook();
    const request = await insertRequest(nb);
    const suggestion = await insertSuggestion(nb, request);
    await notify(suggested(nb, request, suggestion));
    await waitFor(() => aiOf(c)?.status === "suggestion", "suggestion");
    Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(docWithSqlCell("cell-2")));
    await waitFor(
      () => s.sync.manager.rooms.get(nb)?.doc.getMap("cells").has("cell-2") === true,
      "the server has cell-2",
    );
    await notify(started(nb, randomUUID()));
    // A later event that does change something proves the previous one was handled.
    await notify(started(nb, randomUUID(), "cell-2"));
    await waitFor(() => aiOf(c, "cell-2")?.status === "thinking", "marker");
    expect(aiOf(c)).toMatchObject({ status: "suggestion", suggestionId: suggestion });
    // Deciding it still clears it as usual.
    await notify(resolved(nb, suggestion));
    await waitFor(() => aiOf(c) === null, "cleared");
  });

  it("applies a suggestion and its resolution in order, though the first reads the table", async () => {
    const { nb, c } = await openNotebook();
    const request = await insertRequest(nb);
    const suggestion = await insertSuggestion(nb, request);
    const seen: unknown[] = [];
    cellOf(c.doc, CELL)!.observe((event) => {
      if (event.keysChanged.has("ai")) seen.push((aiOf(c) as { status?: string } | null)?.status);
    });
    await notify(started(nb, request));
    await notify(suggested(nb, request, suggestion));
    await notify(resolved(nb, suggestion));
    await waitFor(() => seen.length >= 3, "three changes");
    await sleep(100);
    expect(seen).toEqual(["thinking", "suggestion", undefined]);
    expect(aiOf(c)).toBeNull();
  });

  it("ignores cells that don't exist or aren't SQL", async () => {
    const { nb, c } = await openNotebook();
    c.doc.transact(() => {
      const md = new Y.Map<unknown>();
      md.set("type", "markdown");
      c.doc.getMap("cells").set("md", md);
    });
    await notify(started(nb, randomUUID(), "md"));
    await notify(started(nb, randomUUID(), "missing"));
    await notify(started(nb, randomUUID()));
    await waitFor(() => aiOf(c)?.status === "thinking", "marker");
    expect(cellOf(c.doc, "md")!.has("ai")).toBe(false);
    expect(c.doc.getMap("cells").has("missing")).toBe(false);
    expect(aiPresenceOf(c)).toMatchObject({ ai: { cellId: CELL } });
  });

  it("persists AI state written into a room nobody has open", async () => {
    const nb = await createNotebook(pool, Y.encodeStateAsUpdate(docWithSqlCell(CELL, SQL)));
    const request = await insertRequest(nb);
    await notify(started(nb, request));
    await waitFor(async () => {
      const doc = await storedDoc(pool, nb);
      return (cellOf(doc, CELL)?.get("ai") as Ai)?.status === "thinking";
    }, "stored thinking state");
    await waitFor(() => !s.sync.manager.rooms.has(nb), "room unloaded");
  });
});

describe("the AI's presence", () => {
  function expectAiCursorAtEndOfCell(c: Client) {
    const state = aiPresenceOf(c)!;
    expect(isCursor(state.cursor)).toBe(true);
    const cursor = state.cursor as { anchor: unknown; head: unknown };
    for (const end of [cursor.anchor, cursor.head]) {
      const position = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(end),
        c.doc,
      );
      const source = cellOf(c.doc, CELL)!.get("source") as Y.Text;
      expect(position?.type).toBe(source);
      expect(position?.index).toBe(source.length);
    }
  }

  it("joins while the AI is thinking or has a suggestion, and leaves after", async () => {
    const { nb, c } = await openNotebook();
    const viewer = await open(nb, "viewer");
    const request = await insertRequest(nb);
    await notify(started(nb, request));
    for (const who of [c, viewer]) {
      await waitFor(() => aiPresenceOf(who) !== undefined, "AI presence");
      expect(aiPresenceOf(who)).toMatchObject({
        user: AI_USER,
        ai: { cellId: CELL, status: "thinking" },
      });
    }
    expectAiCursorAtEndOfCell(c);

    const suggestion = await insertSuggestion(nb, request);
    await notify(suggested(nb, request, suggestion));
    await waitFor(
      () => (aiPresenceOf(c)?.ai as { status?: string })?.status === "suggestion",
      "presence follows the suggestion",
    );
    expectAiCursorAtEndOfCell(c);

    await notify(resolved(nb, suggestion));
    await waitFor(() => aiPresenceOf(c) === undefined, "AI presence gone");
    await waitFor(() => aiPresenceOf(viewer) === undefined, "gone for the viewer too");
  });

  it("leaves when the request fails", async () => {
    const { nb, c } = await openNotebook();
    const request = randomUUID();
    await notify(started(nb, request));
    await waitFor(() => aiPresenceOf(c) !== undefined, "AI presence");
    await notify(failed(nb, request));
    await waitFor(() => aiPresenceOf(c) === undefined, "AI presence gone");
  });

  it("is in the presence list a joining client gets, from a stored state", async () => {
    const nb = await createNotebook(pool);
    // Running and recent: reconciliation on load leaves it thinking.
    const request = await insertRequest(nb);
    await notebookThinkingWithRequestIn(nb, request);
    const c = await open(nb, "viewer");
    await waitFor(() => aiPresenceOf(c) !== undefined, "AI presence for a joiner");
    expect(aiPresenceOf(c)).toMatchObject({ ai: { cellId: CELL, status: "thinking" } });
    expectAiCursorAtEndOfCell(c);
  });

  it("goes when the cell it's in is deleted", async () => {
    const { nb, c } = await openNotebook();
    await notify(started(nb, randomUUID()));
    await waitFor(() => aiPresenceOf(c) !== undefined, "AI presence");
    c.doc.transact(() => c.doc.getMap("cells").delete(CELL));
    await waitFor(() => aiPresenceOf(c) === undefined, "AI presence gone");
  });

  it("can't be claimed or overwritten by a viewer's connection", async () => {
    const { nb, c } = await openNotebook();
    const viewer = await member(pool, nb, "viewer", "Mallory");
    const frame = (clientId: number, clock: number, state: unknown) => {
      const update = encoding.createEncoder();
      encoding.writeVarUint(update, 1);
      encoding.writeVarUint(update, clientId);
      encoding.writeVarUint(update, clock);
      encoding.writeVarString(update, JSON.stringify(state));
      const message = encoding.createEncoder();
      encoding.writeVarUint(message, 1); // awareness
      encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
      return encoding.toUint8Array(message);
    };
    const fakeAi = { user: AI_USER, ai: { cellId: CELL, status: "thinking" } };
    // Its very first announcement claims the reserved ID; then its own.
    const socket = rawSocket(`${s.url}/notebooks/${nb}?ticket=${ticketFor(viewer, nb)}`, {
      onOpen: (ws) => {
        ws.send(frame(AI_CLIENT_ID, 5, fakeAi));
        ws.send(frame(777, 1, { marker: "mallory's" }));
      },
    });
    await waitFor(() => c.provider.awareness.getStates().has(777), "the viewer's own state");
    expect(aiPresenceOf(c)).toBeUndefined();

    // Once the AI is really present, the viewer can't overwrite it either.
    await notify(started(nb, randomUUID()));
    await waitFor(() => aiPresenceOf(c) !== undefined, "AI presence");
    socket.ws.send(frame(AI_CLIENT_ID, 2 ** 40, { user: { name: "Mallory" }, cursor: null }));
    socket.ws.send(frame(777, 2, { marker: "later" }));
    await waitFor(
      () => c.provider.awareness.getStates().get(777)?.marker === "later",
      "a later message",
    );
    expect(aiPresenceOf(c)).toMatchObject({ user: AI_USER });
    socket.ws.close();
    await socket;
  });
});

/** Kills the listener's database connection and waits until it has listened again. */
async function killListener(): Promise<void> {
  const pid = await s.sync.listener!.backendPid();
  expect(pid).not.toBeNull();
  await pool.query("SELECT pg_terminate_backend($1)", [pid]);
  await waitFor(async () => {
    const current = await s.sync.listener!.backendPid().catch(() => null);
    return current !== null && current !== pid;
  }, "a new listener connection");
}

describe("reconciling AI states whose events were missed", () => {
  /** A notebook stored while the cell showed `ai`, opened by an editor. */
  async function reopen(nb: string): Promise<Client> {
    return open(nb);
  }

  async function notebookThinking(request: string): Promise<string> {
    return createNotebook(
      pool,
      Y.encodeStateAsUpdate(
        docWithAi({
          status: "thinking",
          requestId: request,
          kind: "fix",
          by: "Ada",
          startedAt: "2026-11-13T12:00:00Z",
        }),
      ),
    );
  }

  it("shows the request's pending suggestion, on load", async () => {
    const nb = await createNotebook(pool);
    const request = await insertRequest(nb, { status: "succeeded" });
    const suggestion = await insertSuggestion(nb, request);
    await notebookThinkingWithRequestIn(nb, request);
    const c = await reopen(nb);
    await waitFor(() => aiOf(c)?.status === "suggestion", "suggestion");
    expect(aiOf(c)).toMatchObject({ suggestionId: suggestion, sql: "SELECT 2", by: "Ada" });
  });

  it.each([
    ["failed", { status: "failed" }],
    ["succeeded without a suggestion", { status: "succeeded" }],
    ["still running but stale", { status: "running", ageSeconds: 180 }],
  ])("fails a request that %s, on load", async (_why, options) => {
    const nb0 = await createNotebook(pool);
    const request = await insertRequest(nb0, options);
    const nb = await notebookThinkingWithRequestIn(nb0, request);
    const c = await reopen(nb);
    await waitFor(() => aiOf(c)?.status === "failed", "failed");
    expect(aiOf(c)).toEqual({ status: "failed", requestId: request, message: STOPPED_MESSAGE });
  });

  it("fails a request that isn't stored at all", async () => {
    const nb = await notebookThinking(randomUUID());
    const c = await reopen(nb);
    await waitFor(() => aiOf(c)?.status === "failed", "failed");
  });

  it("leaves a request that's still running and recent", async () => {
    const nb0 = await createNotebook(pool);
    const request = await insertRequest(nb0, { status: "running", ageSeconds: 30 });
    const nb = await notebookThinkingWithRequestIn(nb0, request);
    const c = await reopen(nb);
    await sleep(300);
    expect(aiOf(c)).toMatchObject({ status: "thinking", requestId: request });
    expect(aiPresenceOf(c)).toMatchObject({ ai: { cellId: CELL, status: "thinking" } });
  });

  it("clears a thinking state whose suggestion was already decided", async () => {
    const nb0 = await createNotebook(pool);
    const request = await insertRequest(nb0, { status: "succeeded" });
    await insertSuggestion(nb0, request, { status: "accepted" });
    const nb = await notebookThinkingWithRequestIn(nb0, request);
    const c = await reopen(nb);
    await waitFor(() => aiOf(c) === null, "cleared");
  });

  it.each(["accepted", "rejected", "gone"])(
    "clears a suggestion that was %s, on load, and keeps a pending one",
    async (outcome) => {
      const nb = await createNotebook(pool);
      const request = await insertRequest(nb, { status: "succeeded" });
      const decided = await insertSuggestion(nb, request, {
        status: outcome === "gone" ? "pending" : outcome,
      });
      if (outcome === "gone") {
        await pool.query("DELETE FROM ai_suggestions WHERE id = $1", [decided]);
      }
      const pending = await insertSuggestion(nb, request, { cellId: "cell-2" });
      const doc = docWithAi({ status: "suggestion", requestId: request, suggestionId: decided });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(docWithSqlCell("cell-2")));
      doc.transact(() =>
        cellOf(doc, "cell-2")!.set("ai", {
          status: "suggestion",
          requestId: request,
          suggestionId: pending,
        }),
      );
      await setDocument(nb, doc);
      const c = await reopen(nb);
      await waitFor(() => aiOf(c) === null, "decided suggestion cleared");
      expect(aiOf(c, "cell-2")).toMatchObject({ suggestionId: pending });
      expect(aiPresenceOf(c)).toMatchObject({ ai: { cellId: "cell-2", status: "suggestion" } });
    },
  );

  it("settles loaded rooms after the listener reconnects", async () => {
    const { nb, c } = await openNotebook();
    const request = await insertRequest(nb);
    await notify(started(nb, request));
    await waitFor(() => aiOf(c)?.status === "thinking", "thinking");
    // The request ends while the listener is down: never announced.
    const suggestion = await insertSuggestion(nb, request);
    await pool.query("UPDATE ai_requests SET status = 'succeeded' WHERE id = $1", [request]);
    await killListener();
    await waitFor(() => aiOf(c)?.status === "suggestion", "reconciled suggestion");
    expect(aiOf(c)).toMatchObject({ suggestionId: suggestion, by: "Ada" });
  });

  describe("re-checking a request that may have died", () => {
    // A server whose re-check comes after 300 ms instead of two minutes. It
    // doesn't listen; the test hands it events directly.
    async function withQuickServer(test: (quick: RunningServer) => Promise<void>) {
      const quick = await startServer({ pool, timings: { aiStaleCheckMs: 300 } });
      try {
        await test(quick);
      } finally {
        await quick.sync.stop();
      }
    }

    async function openOn(quick: RunningServer, nb: string): Promise<Client> {
      const who = await member(pool, nb, "editor");
      const c = connectClient(quick, nb, ticketFor(who, nb));
      clients.push(c);
      await synced(c);
      return c;
    }

    it("after the AI starts thinking, settles a request that ended unannounced", async () => {
      await withQuickServer(async (quick) => {
        const nb = await createNotebook(pool, Y.encodeStateAsUpdate(docWithSqlCell(CELL, SQL)));
        const c = await openOn(quick, nb);
        const request = await insertRequest(nb);
        quick.sync.manager.handleEvent({
          type: "ai_started",
          notebookId: nb,
          cellId: CELL,
          requestId: request,
          kind: "fix",
          userName: "Ada",
        });
        await waitFor(() => aiOf(c)?.status === "thinking", "thinking");
        // Its API process dies: the row says failed, no event ever comes.
        await pool.query("UPDATE ai_requests SET status = 'failed' WHERE id = $1", [request]);
        await waitFor(() => aiOf(c)?.status === "failed", "failed by the re-check", 3_000);
        expect(aiOf(c)).toMatchObject({ message: STOPPED_MESSAGE });
      });
    });

    it("after a reload finds it still running, settles it once it goes stale", async () => {
      await withQuickServer(async (quick) => {
        const nb = await createNotebook(pool);
        const request = await insertRequest(nb, { ageSeconds: 30 });
        await notebookThinkingWithRequestIn(nb, request);
        const c = await openOn(quick, nb);
        await sleep(100);
        expect(aiOf(c)?.status).toBe("thinking"); // running and recent: left alone
        // Time passes (by the database's clock) without an answer.
        await pool.query(
          "UPDATE ai_requests SET created_at = now() - interval '3 minutes' WHERE id = $1",
          [request],
        );
        await waitFor(() => aiOf(c)?.status === "failed", "failed by the re-check", 3_000);
      });
    });
  });

  it("clears a suggestion resolved while the listener was down", async () => {
    const { nb, c } = await openNotebook();
    const request = await insertRequest(nb);
    const suggestion = await insertSuggestion(nb, request);
    await notify(suggested(nb, request, suggestion));
    await waitFor(() => aiOf(c)?.status === "suggestion", "suggestion");
    await pool.query("UPDATE ai_suggestions SET status = 'rejected' WHERE id = $1", [suggestion]);
    await killListener();
    await waitFor(() => aiOf(c) === null, "cleared");
    await waitFor(() => aiPresenceOf(c) === undefined, "AI presence gone");
  });
});

/** Replaces a notebook's stored document (no room may be loaded for it). */
async function setDocument(nb: string, doc: Y.Doc): Promise<void> {
  await pool.query(
    `INSERT INTO notebook_snapshots (notebook_id, state) VALUES ($1, $2)
     ON CONFLICT (notebook_id) DO UPDATE SET state = EXCLUDED.state`,
    [nb, Buffer.from(Y.encodeStateAsUpdate(doc))],
  );
}

/** Stores, in notebook `nb`, a document whose cell is thinking about `request`. */
async function notebookThinkingWithRequestIn(nb: string, request: string): Promise<string> {
  await setDocument(
    nb,
    docWithAi({ status: "thinking", requestId: request, kind: "fix", by: "Ada" }),
  );
  return nb;
}
