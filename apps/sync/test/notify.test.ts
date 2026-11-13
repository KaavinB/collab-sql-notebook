/** API events through real Postgres NOTIFY, applied to loaded and unloaded rooms. */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { CHANNEL } from "../src/notify.ts";
import {
  cellOf,
  closeClient,
  connectClient,
  createNotebook,
  docWithSqlCell,
  logRows,
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

async function notify(payload: unknown): Promise<void> {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  await pool.query("SELECT pg_notify($1, $2)", [CHANNEL, text]);
}

const CELL = "cell-1";

async function openNotebook(): Promise<{ nb: string; c: Client }> {
  const nb = await createNotebook(pool, Y.encodeStateAsUpdate(docWithSqlCell(CELL)));
  const editor = await member(pool, nb, "editor");
  const c = connectClient(s, nb, ticketFor(editor, nb));
  clients.push(c);
  await synced(c);
  return { nb, c };
}

function started(nb: string, executionId: string, cellId = CELL) {
  return {
    type: "run_started",
    notebook_id: nb,
    cell_id: cellId,
    execution_id: executionId,
    user_name: "Alice",
    started_at: "2026-11-13T12:00:00+00:00",
  };
}

function finished(nb: string, executionId: string, runId: string | null, cellId = CELL) {
  return {
    type: "run_finished",
    notebook_id: nb,
    cell_id: cellId,
    execution_id: executionId,
    run_id: runId,
  };
}

describe("run events", () => {
  it("records when the run's lock expires, so clients can stop showing it", async () => {
    const { nb, c } = await openNotebook();
    const execution = randomUUID();
    await notify({ ...started(nb, execution), expires_at: "2026-11-13T12:00:27+00:00" });
    await waitFor(() => cellOf(c.doc, CELL)?.get("running") != null, "running state");
    expect(cellOf(c.doc, CELL)!.get("running")).toMatchObject({
      executionId: execution,
      expiresAt: "2026-11-13T12:00:27+00:00",
    });
  });

  it("ignores a run_started with a malformed expiry", async () => {
    const { nb, c } = await openNotebook();
    await notify({ ...started(nb, randomUUID()), expires_at: "tomorrow-ish" });
    await notify({ ...started(nb, randomUUID()), user_name: "Bob" });
    await waitFor(
      () => (cellOf(c.doc, CELL)?.get("running") as { by?: string })?.by === "Bob",
      "later event",
    );
  });

  it("writes the running state and then the finished run into the document", async () => {
    const { nb, c } = await openNotebook();
    const execution = randomUUID();
    await notify(started(nb, execution));
    await waitFor(() => cellOf(c.doc, CELL)?.get("running") != null, "running state");
    expect(cellOf(c.doc, CELL)!.get("running")).toEqual({
      executionId: execution,
      by: "Alice",
      startedAt: "2026-11-13T12:00:00+00:00",
      expiresAt: null, // the event didn't say
    });

    const run = randomUUID();
    await notify(finished(nb, execution, run));
    await waitFor(() => cellOf(c.doc, CELL)?.get("lastRunId") === run, "lastRunId");
    expect(cellOf(c.doc, CELL)!.get("running")).toBeNull();
  });

  it("leaves a newer execution's running state alone, and keeps lastRunId on a failed run", async () => {
    const { nb, c } = await openNotebook();
    const older = randomUUID();
    const newer = randomUUID();
    await notify(started(nb, newer));
    await waitFor(() => cellOf(c.doc, CELL)?.get("running") != null, "running state");
    await notify(finished(nb, older, null));
    // A later event that does change something proves the previous one was handled.
    await notify(finished(nb, newer, null, "no-such-cell"));
    await notify({ ...started(nb, newer), user_name: "Bob" });
    await waitFor(
      () => (cellOf(c.doc, CELL)?.get("running") as { by?: string })?.by === "Bob",
      "later event",
    );
    expect((cellOf(c.doc, CELL)!.get("running") as { executionId: string }).executionId).toBe(
      newer,
    );
    expect(cellOf(c.doc, CELL)!.get("lastRunId")).toBeNull();
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
    const marker = randomUUID();
    await notify(started(nb, marker));
    await waitFor(() => cellOf(c.doc, CELL)?.get("running") != null, "marker event");
    expect(cellOf(c.doc, "md")!.has("running")).toBe(false);
    expect(c.doc.getMap("cells").has("missing")).toBe(false);
  });

  it("persists run state written into a room nobody has open", async () => {
    const nb = await createNotebook(pool, Y.encodeStateAsUpdate(docWithSqlCell(CELL)));
    const run = randomUUID();
    const execution = randomUUID();
    await notify(started(nb, execution));
    await notify(finished(nb, execution, run));
    await waitFor(async () => {
      const doc = await storedDoc(pool, nb);
      return cellOf(doc, CELL)?.get("lastRunId") === run;
    }, "stored lastRunId");
    await waitFor(() => !s.sync.manager.rooms.has(nb), "room unloaded");
    // Saved, compacted into the snapshot, and the room unloaded.
    expect(await logRows(pool, nb)).toBe(0);
    const doc = await storedDoc(pool, nb);
    expect(cellOf(doc, CELL)!.get("running")).toBeNull();
    expect(cellOf(doc, CELL)!.get("source")!.toString()).toBe("SELECT 1");
  });

  it("ignores malformed payloads and unknown event types", async () => {
    const { nb, c } = await openNotebook();
    await notify("not json");
    await notify({ type: "something_new", notebook_id: nb });
    await notify({ ...started(nb, randomUUID()), cell_id: "bad id with spaces" });
    await notify({ ...started(nb, randomUUID()), notebook_id: "not-a-uuid" });
    await notify({ ...finished(nb, randomUUID(), "not-a-uuid") });
    const marker = randomUUID();
    await notify(started(nb, marker));
    await waitFor(() => cellOf(c.doc, CELL)?.get("running") != null, "valid event");
    expect((cellOf(c.doc, CELL)!.get("running") as { executionId: string }).executionId).toBe(
      marker,
    );
  });
});

describe("access events", () => {
  it("closes only the affected user's sockets with 4403", async () => {
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor");
    const bob = await member(pool, nb, "editor");
    const a = connectClient(s, nb, ticketFor(alice, nb));
    const b = connectClient(s, nb, ticketFor(bob, nb));
    clients.push(a, b);
    await Promise.all([synced(a), synced(b)]);
    const codes: number[] = [];
    a.provider.on("connection-close", (event) => codes.push(event!.code));

    await notify({ type: "access_changed", notebook_id: nb, user_id: alice.userId });
    await waitFor(() => codes.length === 1, "Alice's socket closed");
    expect(codes).toEqual([4403]);
    expect(b.provider.wsconnected).toBe(true);
  });

  it("closes every socket with 4404 when the notebook is deleted, saving nothing", async () => {
    const { nb, c } = await openNotebook();
    const viewer = await member(pool, nb, "viewer");
    const v = rawSocket(`${s.url}/notebooks/${nb}?ticket=${ticketFor(viewer, nb)}`);
    const codes: number[] = [];
    c.provider.on("connection-close", (event) => codes.push(event!.code));
    await waitFor(() => s.sync.manager.rooms.get(nb)?.conns.size === 2, "both connected");

    // The API deletes the row and notifies in the same transaction.
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("DELETE FROM notebooks WHERE id = $1", [nb]);
      await tx.query("SELECT pg_notify($1, $2)", [
        CHANNEL,
        JSON.stringify({ type: "notebook_deleted", notebook_id: nb }),
      ]);
      await tx.query("COMMIT");
    } finally {
      tx.release();
    }
    expect(await v).toEqual({ closeCode: 4404 });
    await waitFor(() => codes.length === 1, "editor closed");
    expect(codes).toEqual([4404]);
    expect(s.sync.manager.rooms.has(nb)).toBe(false);
  });

  it("drops a room's unsaved changes when its notebook was deleted under it", async () => {
    // No NOTIFY this time (say the listener was reconnecting): the next
    // write fails on the foreign key and the room closes with 4404.
    const quiet = await startServer({ pool, timings: { flushIntervalMs: 50 } });
    try {
      const nb = await createNotebook(pool);
      const editor = await member(pool, nb, "editor");
      const c = connectClient(quiet, nb, ticketFor(editor, nb));
      clients.push(c);
      await synced(c);
      const codes: number[] = [];
      c.provider.on("connection-close", (event) => codes.push(event!.code));
      await pool.query("DELETE FROM notebooks WHERE id = $1", [nb]);
      c.doc.getText("t").insert(0, "too late");
      await waitFor(() => codes.length === 1, "closed");
      expect(codes).toEqual([4404]);
      expect(quiet.sync.manager.rooms.has(nb)).toBe(false);
    } finally {
      await quiet.sync.stop();
    }
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

describe("listener", () => {
  it("reconnects after its connection is killed", async () => {
    await killListener();
    const { nb, c } = await openNotebook();
    await notify(started(nb, randomUUID()));
    await waitFor(() => cellOf(c.doc, CELL)?.get("running") != null, "event after reconnect");
  });

  it("re-checks access after reconnecting, since events sent meanwhile were lost", async () => {
    const nb = await createNotebook(pool);
    const alice = await member(pool, nb, "editor");
    const bob = await member(pool, nb, "editor");
    const a = connectClient(s, nb, ticketFor(alice, nb));
    const b = connectClient(s, nb, ticketFor(bob, nb));
    clients.push(a, b);
    await Promise.all([synced(a), synced(b)]);
    const doomed = await openNotebook();
    const codes: number[] = [];
    a.provider.on("connection-close", (event) => codes.push(event!.code));
    const doomedCodes: number[] = [];
    doomed.c.provider.on("connection-close", (event) => doomedCodes.push(event!.code));

    // Changes whose NOTIFY never arrived (the listener was down).
    await pool.query("UPDATE notebook_members SET role = 'viewer' WHERE user_id = $1", [
      alice.userId,
    ]);
    await pool.query("DELETE FROM notebooks WHERE id = $1", [doomed.nb]);
    await killListener();

    await waitFor(() => codes.length === 1 && doomedCodes.length === 1, "both closed");
    expect(codes).toEqual([4403]);
    expect(doomedCodes).toEqual([4404]);
    expect(b.provider.wsconnected).toBe(true);
    expect(s.sync.manager.rooms.has(doomed.nb)).toBe(false);
  });
});

describe("reconciling runs whose end was missed", () => {
  // A document stored while a run was in flight, then the run_finished was
  // never delivered (listener reconnecting, or the API process died).
  async function notebookStuckRunning(executionId: string): Promise<string> {
    const doc = docWithSqlCell(CELL);
    doc.transact(() =>
      cellOf(doc, CELL)!.set("running", {
        executionId,
        by: "Alice",
        startedAt: "2026-11-13T12:00:00+00:00",
        expiresAt: null,
      }),
    );
    return createNotebook(pool, Y.encodeStateAsUpdate(doc));
  }

  async function storeRun(nb: string, executionId: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO cell_runs (id, notebook_id, cell_id, sql, status, result, execution_id)
       VALUES ($1, $2, $3, 'select 1', 'ok', '{}', $4)`,
      [id, nb, CELL, executionId],
    );
    return id;
  }

  async function open(nb: string): Promise<Client> {
    const editor = await member(pool, nb, "editor");
    const c = connectClient(s, nb, ticketFor(editor, nb));
    clients.push(c);
    await synced(c);
    return c;
  }

  it("points the cell at the run its execution stored and clears running, on load", async () => {
    const execution = randomUUID();
    const nb = await notebookStuckRunning(execution);
    const run = await storeRun(nb, execution);
    const c = await open(nb);
    await waitFor(() => cellOf(c.doc, CELL)?.get("running") === null, "running cleared");
    expect(cellOf(c.doc, CELL)!.get("lastRunId")).toBe(run);
  });

  it("clears running without a result when the execution stored nothing", async () => {
    const nb = await notebookStuckRunning(randomUUID());
    const c = await open(nb);
    await waitFor(() => cellOf(c.doc, CELL)?.get("running") === null, "running cleared");
    expect(cellOf(c.doc, CELL)!.get("lastRunId")).toBeNull();
  });

  it("leaves a run that still holds its lock alone", async () => {
    const execution = randomUUID();
    const nb = await notebookStuckRunning(execution);
    await pool.query(
      `INSERT INTO cell_executions (notebook_id, cell_id, execution_id, started_at, expires_at)
       VALUES ($1, $2, $3, now(), now() + interval '1 minute')`,
      [nb, CELL, execution],
    );
    const c = await open(nb);
    await sleep(300);
    expect(cellOf(c.doc, CELL)!.get("running")).toMatchObject({ executionId: execution });
  });

  it("settles runs in loaded rooms after the listener reconnects", async () => {
    const { nb, c } = await openNotebook();
    const execution = randomUUID();
    await notify(started(nb, execution));
    await waitFor(() => cellOf(c.doc, CELL)?.get("running") != null, "running state");
    // The run finishes while the listener is down: stored, but never announced.
    const run = await storeRun(nb, execution);
    await killListener();
    await waitFor(() => cellOf(c.doc, CELL)?.get("lastRunId") === run, "reconciled run");
    expect(cellOf(c.doc, CELL)!.get("running")).toBeNull();
  });
});
