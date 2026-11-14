/**
 * Convergence fuzz test: simulated clients edit one notebook at random
 * through our real sync server code, and every replica must end identical.
 *
 * What runs for real: RoomManager, Room, Connection, the message handling
 * and viewer filtering, and the Postgres Store with its append log,
 * compaction and room unload/reload (timings shrunk so they happen all the
 * time). What's simulated: the network and the browsers (see fuzz-sim.ts).
 *
 * Each run, driven by one seed:
 * - a few editors and a viewer connect, edit the notebook's real document
 *   shape (type, delete and replace text in cells' Y.Text; add, delete and
 *   move cells; change cell fields; move cursors), thousands of edits in all,
 *   most of them in a few "hot" cells so that clients keep typing into the
 *   same text at the same time throughout the run;
 * - messages are delivered in random order across sockets (each socket stays
 *   ordered, like TCP), sockets stall for a while, and connections drop
 *   mid-stream, losing part of what was in flight. Disconnected clients keep
 *   editing offline and later reconnect with a new connection, which does
 *   the sync handshake again;
 * - the viewer edits too, and the server must drop every one of those edits;
 * - the API's events (runs, AI requests) make the server write to the
 *   document itself;
 * - some store calls fail on purpose (before writing, or after writing with
 *   the reply lost), so retries, failed loads and repeated rows happen;
 * - once per run, everyone leaves and one editor comes back while the room
 *   is still unloading (it must stay loaded); once, everyone leaves (the
 *   room saves, compacts and unloads, and is reloaded from Postgres when
 *   they come back); the server crashes
 *   (unsaved changes are lost; editors send them again when they reconnect)
 *   and the server restarts cleanly;
 * - a few times per run (checkpoints), every queued message is delivered
 *   without reconnecting anyone, and every connected client must match the
 *   server (editors exactly, viewers by the viewer rule below). The final
 *   check alone would miss a server that loses a relayed message, because a
 *   reconnect's handshake repairs it.
 * Then everyone reconnects, every message is delivered, and:
 * - every editor's document, the server's in-memory document, and a fresh
 *   load from Postgres are byte-identical: the same state vector, the same
 *   delete set, and the same encoded state (Y.encodeStateAsUpdate, after
 *   loading into a fresh document, because replicas cut the same content
 *   into different struct pieces; see canonicalState in fuzz-sim.ts). A
 *   mismatch prints where the documents' JSON first differs;
 * - no viewer's edit appears anywhere; a viewer has every change and every
 *   deletion the server has (deletions are checked separately: they don't
 *   show in a state vector); and a freshly loaded viewer matches the server
 *   byte for byte. One
 *   known exception is allowed and counted (viewerKeptLostServerChanges): a
 *   change the server made itself that reached the viewer and was lost in
 *   the crash before being saved stays in that viewer's replica (see the
 *   test in rooms.test.ts that pins it);
 * - nothing is left waiting on missing updates, and the server never logged
 *   a message it couldn't handle.
 *
 * Knobs (environment variables):
 *   FUZZ_SEED=<n>      the first seed; on its own, run only this seed (replay a failure)
 *   FUZZ_RUNS=<n>      how many seeds, counting up from FUZZ_SEED or 1 (default: seeds 1-4)
 *   FUZZ_OPS=<n>       edits per run (default 4000)
 *   FUZZ_EDITORS=<n>   editors per run (default 4); there is always 1 viewer
 *   FUZZ_FAILURES=<p>  share of store calls that fail on purpose (default 0.03)
 *   FUZZ_CHECKPOINTS=<n>  mid-run checks per run (default 3; see FuzzRun.checkpoint)
 *   FUZZ_VERBOSE=1     print each run's schedule fingerprint and statistics
 *   FUZZ_TRACE_DIR=<dir>  write each run's full schedule to <dir>/seed-<n>-<fingerprint>.txt
 * Example, a long soak: FUZZ_RUNS=50 FUZZ_OPS=10000 pnpm --dir apps/sync exec vitest run test/fuzz.test.ts
 *
 * What replays, and what doesn't:
 * - Every random draw comes from seeded generators and fixed lists (never
 *   from "which sockets have messages now"), injected store failures are
 *   keyed by call kind and count, and the run waits for the server to
 *   finish what it started (loads, event handling, unloads) before going
 *   on. Unloads, the crash's losses and the restart's save happen at fixed
 *   points (see fuzz-sim.ts). So the schedule (every action, in order) is
 *   meant to be a function of the seed and the knobs. FUZZ_VERBOSE prints a
 *   fingerprint of it, and FUZZ_TRACE_DIR=<dir> writes it out in full, so
 *   two runs can be compared. The last test below runs one seed twice and
 *   checks the fingerprints match.
 * - Not controlled: the server's real timing (Postgres latency, when a
 *   batch is written or compacted), which appends and compactions an
 *   injected failure hits, and the timestamps the server writes. (The
 *   rooms' Yjs client IDs are fixed by the run: they decide the order a
 *   reloaded room sees its cells in.) These are meant to change bytes in
 *   the document, not the schedule, but nothing forces that, and some
 *   seeds still diverge now and then. So a failure usually replays; one
 *   that depends on the server's timing may not.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  docJson,
  firstDifference,
  FuzzRun,
  initialDocument,
  replicaDigest,
  stateVector,
  viewerProblems,
  type Member,
  type ReplicaDigest,
} from "./fuzz-sim.ts";
import { createNotebook, member, newPool, truncate } from "./helpers.ts";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number`);
  return value;
}

const SEED = process.env.FUZZ_SEED;
const RUNS = envInt("FUZZ_RUNS", SEED ? 1 : 4);
const FIRST_SEED = envInt("FUZZ_SEED", 1);
const OPS = envInt("FUZZ_OPS", 4000);
const EDITORS = envInt("FUZZ_EDITORS", 4);
const FAILURES = Number(process.env.FUZZ_FAILURES ?? "0.03");
const CHECKPOINTS = envInt("FUZZ_CHECKPOINTS", 3);
const VERBOSE = process.env.FUZZ_VERBOSE === "1";
const TRACE_DIR = process.env.FUZZ_TRACE_DIR;
/** Edits per run in the replay check (two runs of one seed). */
const REPLAY_OPS = 1000;
const SEEDS = Array.from({ length: RUNS }, (_, i) => FIRST_SEED + i);

let pool: pg.Pool;

beforeAll(() => {
  pool = newPool();
});

afterAll(async () => {
  await pool.end();
});

function replayHint(seed: number, fingerprint: string): string {
  return (
    `Fuzz seed ${seed} failed (schedule ${fingerprint}). Run the same schedule again with:\n` +
    `  FUZZ_SEED=${seed} FUZZ_OPS=${OPS} FUZZ_EDITORS=${EDITORS} FUZZ_FAILURES=${FAILURES} ` +
    `FUZZ_CHECKPOINTS=${CHECKPOINTS} FUZZ_VERBOSE=1 ` +
    `pnpm --dir apps/sync exec vitest run test/fuzz.test.ts\n` +
    `The schedule should repeat (compare the printed fingerprint), but the server's ` +
    `own timing is real, so a failure that depends on it may not (see the file header).`
  );
}

/** Everything that differs between the replicas, as readable lines. */
async function differences(run: FuzzRun, viewers: Member[]): Promise<string[]> {
  const found: string[] = [...run.problems];
  const server = run.serverDoc();
  const serverDigest = replicaDigest(server);
  const serverJson = docJson(server);
  const compare = (label: string, doc: Y.Doc) => {
    const digest = replicaDigest(doc);
    const parts = (Object.keys(digest) as (keyof ReplicaDigest)[]).filter(
      (part) => digest[part] !== serverDigest[part],
    );
    if (parts.length === 0) return;
    found.push(
      `${label} differs from the server's document (${parts.join(", ")}) ` +
        firstDifference(docJson(doc), serverJson),
    );
  };

  for (const { label, doc } of run.editorDocs()) compare(label, doc);
  const stored = await run.storedDoc();
  compare("the document loaded from Postgres", stored);

  // Viewers: their edits exist only in their own replica.
  const viewerIds = new Set(run.viewerClients().map((c) => c.doc.clientID));
  for (const [label, doc] of [
    ["the server", server],
    ["the document loaded from Postgres", stored],
    ...run.editorDocs().map(({ label, doc }) => [label, doc] as const),
  ] as const) {
    for (const id of stateVector(doc).keys()) {
      if (viewerIds.has(id)) found.push(`a viewer's edit reached ${label}`);
    }
  }
  // A viewer has every change and deletion the server has (see
  // viewerProblems for the one known exception, which is counted).
  for (const viewer of run.viewerClients()) {
    const result = viewerProblems(server, viewer, run.crashedServerClients);
    run.stats.viewerKeptLostServerChanges += result.knownLimit;
    found.push(...result.problems);
  }
  for (const member of viewers) {
    compare("a freshly loaded viewer", await run.freshViewerDoc(member));
  }

  // Nothing may be left waiting for updates that never came.
  for (const [label, doc] of [
    ["the server", server],
    ...run.editorDocs().map(({ label, doc }) => [label, doc] as const),
    ...run.viewerClients().map((c) => [c.label, c.doc] as const),
  ] as const) {
    if (doc.store.pendingStructs || doc.store.pendingDs) {
      found.push(`${label} still holds updates with missing dependencies`);
    }
  }
  stored.destroy();
  return found;
}

/** One run of one seed, from an empty database: the run, what went wrong, its statistics. */
async function runSeed(seed: number, ops: number) {
  await truncate(pool);
  const notebookId = await createNotebook(pool, initialDocument());
  const editors: Member[] = [];
  for (let i = 0; i < EDITORS; i++) {
    editors.push(await member(pool, notebookId, i === 0 ? "owner" : "editor", `E${i}`));
  }
  const viewers = [await member(pool, notebookId, "viewer", "V0")];
  const run = new FuzzRun({
    seed,
    ops,
    editors,
    viewers,
    failureRate: FAILURES,
    checkpoints: CHECKPOINTS,
    pool,
    notebookId,
  });
  let found: string[] = [];
  try {
    await run.run();
    await run.flushRoom();
    found = await differences(run, viewers);
  } catch (error) {
    found.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  } finally {
    await run.close();
  }
  const stats = run.collectStats();
  if (TRACE_DIR) {
    mkdirSync(TRACE_DIR, { recursive: true });
    const file = path.join(TRACE_DIR, `seed-${seed}-${run.fingerprint}.txt`);
    writeFileSync(file, `${run.schedule.join("\n")}\n`);
  }
  // Straight to stdout: vitest holds back console output of passing tests.
  if (VERBOSE) {
    process.stdout.write(
      `fuzz seed ${seed}: schedule ${run.fingerprint} ${JSON.stringify(stats)}\n`,
    );
  }
  return { run, found, stats };
}

describe("convergence fuzz", () => {
  for (const seed of SEEDS) {
    it(
      `every replica ends identical (seed ${seed})`,
      async () => {
        const { run, found, stats } = await runSeed(seed, OPS);
        if (found.length > 0) {
          throw new Error(
            `${replayHint(seed, run.fingerprint)}\n\n` +
              `Problems:\n- ${found.slice(0, 20).join("\n- ")}\n\n` +
              `Last actions:\n${run.trace.join("\n")}`,
          );
        }
        // The run must actually have exercised what it claims to.
        expect(stats.roomLoads).toBeGreaterThanOrEqual(3); // first load + reloads
        expect(stats.unloads).toBe(1);
        expect(stats.returnsDuringUnload).toBe(1);
        expect(stats.crashes).toBe(1);
        expect(stats.restarts).toBe(1);
        expect(stats.viewerEdits).toBeGreaterThan(0);
        expect(stats.drops).toBeGreaterThan(0);
      },
      Math.max(120_000, OPS * 40),
    );
  }

  // The replay promise, checked: the same seed, run twice, takes the same
  // actions in the same order. Short runs, to stay cheap.
  it("runs the same schedule when a seed runs again", async () => {
    const seed = FIRST_SEED;
    const first = await runSeed(seed, REPLAY_OPS);
    const second = await runSeed(seed, REPLAY_OPS);
    expect(first.found).toEqual([]);
    expect(second.found).toEqual([]);
    if (first.run.fingerprint !== second.run.fingerprint) {
      const a = first.run.schedule;
      const b = second.run.schedule;
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      throw new Error(
        `Seed ${seed} ran two different schedules. They first differ at action ${i}:\n` +
          `  ${a[i] ?? "(end)"}\n  ${b[i] ?? "(end)"}`,
      );
    }
  }, 120_000);
});
