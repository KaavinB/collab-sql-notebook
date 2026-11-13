/**
 * A room: one notebook's live document, the connections editing it, their
 * presence, and the batching that writes its changes to Postgres.
 *
 * Lifecycle (driven by RoomManager):
 *   loading  -> snapshot + log are read from Postgres; connections wait
 *   ready    -> messages flow; changes are batched into the log
 *   deleted  -> the notebook is gone: sockets closed with 4404, nothing saved
 *   failed   -> the load failed: sockets closed with 1011 so clients retry
 *   closed   -> unloaded after everything was saved
 *
 * The room's Y.Doc is the server's replica of the document. Every change,
 * whoever made it, fires the doc's "update" event exactly once, and that one
 * handler both relays the change to the other connections and queues it for
 * Postgres. Updates from viewers never reach the doc, so they're neither
 * relayed nor saved.
 */
import * as Y from "yjs";

import { RoomAwareness } from "./awareness.ts";
import type { Connection } from "./connection.ts";
import { errorMessage, log } from "./log.ts";
import {
  awarenessMessage,
  CloseCode,
  MalformedMessage,
  parseMessage,
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
  syncMessage,
} from "./protocol.ts";
import { NotebookGoneError, type Store } from "./store.ts";

/** Transaction origin for applying the stored document: not a change, not saved again. */
export const LOAD_ORIGIN = Symbol("load");
/** Transaction origin for changes the server makes itself (run state). */
export const SERVER_ORIGIN = Symbol("server");

export interface RoomTimings {
  /**
   * How long changes are collected before they're written as one row. A
   * typing user produces an update per keystroke; batching turns a burst into
   * one small INSERT. A crash loses at most this window of edits that no
   * other client holds (clients that saw them resend them on reconnect).
   */
  flushIntervalMs: number;
  /** A batch this big is written at once instead of waiting for the interval. */
  flushBytes: number;
  /**
   * Compact once the log has this many rows. Loading reads every row, so the
   * log is kept short; at one row per flush interval of continuous typing this
   * is roughly a minute of editing.
   */
  compactAfterRows: number;
  /** First retry delay after a failed write; doubles up to retryMaxMs. */
  retryBaseMs: number;
  retryMaxMs: number;
}

export const DEFAULT_TIMINGS: RoomTimings = {
  flushIntervalMs: 250,
  flushBytes: 256 * 1024,
  compactAfterRows: 200,
  retryBaseMs: 500,
  retryMaxMs: 30_000,
};

// Rounds of writes flushAll does while changes keep arriving mid-write. A
// room being unloaded or shut down has no sockets, so only server events add
// changes, and a few rounds are plenty.
const MAX_FLUSH_ROUNDS = 5;

/**
 * Cap on update data the room holds back because its dependencies are
 * missing (Yjs keeps such "pending" structs until the missing updates
 * arrive). With one server relaying everything in order, a well-behaved
 * client only causes this briefly: an edit made right after reconnecting can
 * arrive just before the sync step 2 that carries the offline edits it builds
 * on. Anything that piles up is a broken or hostile client, and the data is
 * held in memory, never saved or relayed. One maximum-size message fits, so
 * the brief case is never refused.
 */
export const MAX_PENDING_STRUCT_BYTES = 2 * 1024 * 1024;

export type RoomStatus = "loading" | "ready" | "deleted" | "failed" | "closed";

export interface RunningState {
  executionId: string;
  by: string;
  startedAt: string;
  /** When the execution's lock lapses; clients stop showing the run after it. */
  expiresAt: string | null;
}

export class Room {
  status: RoomStatus = "loading";
  readonly doc = new Y.Doc();
  readonly awareness = new RoomAwareness<Connection>();
  readonly conns = new Set<Connection>();
  /** Server-side operations (NOTIFY events) using the room; it stays loaded while > 0. */
  holds = 0;
  /** Resolves when loaded; rejects if the load failed. */
  readonly ready: Promise<void>;
  /** Set by RoomManager while an unload is scheduled or running. */
  unloadTimer: NodeJS.Timeout | null = null;
  unloading = false;

  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private retryDelay = 0;
  private lastWriteFailed = false;
  private logRows = 0;
  private compacting: Promise<void> | null = null;

  readonly id: string;
  private readonly store: Store;
  private readonly timings: RoomTimings;
  /** Called once when the room stops (deleted or failed), so the manager forgets it. */
  private readonly onGone: (room: Room) => void;

  constructor(id: string, store: Store, timings: RoomTimings, onGone: (room: Room) => void) {
    this.id = id;
    this.store = store;
    this.timings = timings;
    this.onGone = onGone;
    this.doc.on("update", this.onDocUpdate);
    this.ready = this.load();
    // Callers observe failures through `ready`; this keeps an unobserved
    // rejection from being reported as unhandled.
    this.ready.catch(() => {});
  }

  private async load(): Promise<void> {
    const started = Date.now();
    let loaded;
    try {
      loaded = await this.store.load(this.id);
    } catch (error) {
      if (this.status === "loading") this.fail("load failed", error);
      throw error;
    }
    if (this.status !== "loading") return; // deleted while loading
    if (loaded === null) {
      this.markDeleted();
      return;
    }
    if (loaded.state) {
      try {
        Y.applyUpdate(this.doc, loaded.state, LOAD_ORIGIN);
      } catch (error) {
        this.fail("stored document is unreadable", error);
        throw error;
      }
    }
    this.logRows = loaded.logRows;
    this.status = "ready";
    log.info("room.loaded", {
      notebook: this.id,
      logRows: loaded.logRows,
      ms: Date.now() - started,
    });
  }

  private fail(why: string, error: unknown): void {
    log.error("room.failed", { notebook: this.id, why, error: errorMessage(error) });
    this.status = "failed";
    this.stop(CloseCode.serverError, "the document could not be loaded");
  }

  /** No connections and no server operations are using the room. */
  get idle(): boolean {
    return this.conns.size === 0 && this.holds === 0;
  }

  /** Changes not yet written to Postgres (pending or being written). */
  get hasUnsaved(): boolean {
    return this.pending.length > 0 || this.flushing !== null;
  }

  // --- Connections ------------------------------------------------------

  /** Starts a connection whose room has loaded and whose access was checked. */
  open(conn: Connection): void {
    if (this.status !== "ready" || conn.state !== "pending") return;
    // Editors get the server's state vector so they send back whatever they
    // changed offline. Viewers' edits would be dropped anyway, so they're
    // not asked.
    if (conn.canWrite) conn.send(syncMessage(SYNC_STEP1, Y.encodeStateVector(this.doc)));
    // Queued messages first: if one claims a clientID (a tab reconnecting
    // while its old socket lingers), the presence list below then treats that
    // entry as the connection's own, instead of sending the tab a stale copy
    // of its own state that would overwrite its local one.
    conn.open((data) => this.handle(conn, data));
    if (!conn.isOpen) return; // a queued message got it closed
    const presence = this.awareness.encodeAll(conn, conn.user.id);
    if (presence) conn.send(awarenessMessage(presence));
  }

  /** Forgets a connection that closed, and tells the others its presence is gone. */
  remove(conn: Connection): void {
    if (!this.conns.delete(conn)) return;
    const removal = this.awareness.removeOwner(conn);
    if (removal) this.broadcast(awarenessMessage(removal), conn);
  }

  private handle(conn: Connection, data: Uint8Array): void {
    try {
      const message = parseMessage(data);
      switch (message.kind) {
        case "sync-step1":
          conn.send(syncMessage(SYNC_STEP2, this.diffFor(message.stateVector)));
          break;
        case "sync-update":
          // Viewers: dropped without a word. Not applied, so not relayed or saved.
          if (conn.canWrite) this.applyClientUpdate(conn, message.update);
          break;
        case "awareness": {
          const { forOwner, forPeers } = this.awareness.apply(conn, conn.user, message.update);
          if (forOwner) conn.send(awarenessMessage(forOwner));
          if (forPeers) this.broadcast(awarenessMessage(forPeers), conn);
          break;
        }
        case "query-awareness": {
          const presence = this.awareness.encodeAll(conn, conn.user.id);
          if (presence) conn.send(awarenessMessage(presence));
          break;
        }
        case "auth":
          break;
      }
    } catch (error) {
      if (error instanceof MalformedMessage) {
        log.warn("conn.malformed", {
          notebook: this.id,
          user: conn.ticket.userId,
          why: error.message,
        });
        conn.close(CloseCode.malformed, "malformed message");
      } else {
        // A bug on our side, not the client's: let it reconnect.
        log.error("conn.handle_failed", { notebook: this.id, error: errorMessage(error) });
        conn.close(CloseCode.serverError, "server error");
      }
    }
  }

  private diffFor(stateVector: Uint8Array): Uint8Array {
    try {
      return Y.encodeStateAsUpdate(this.doc, stateVector);
    } catch {
      throw new MalformedMessage("bad state vector");
    }
  }

  /**
   * Applies an editor's update. It's first decoded on its own, which reads
   * the whole binary format without touching the room's document, so garbage
   * is rejected before it gets anywhere near the shared state. If applying
   * still throws (an update that parses but doesn't make sense), Yjs has
   * already emitted whatever part it integrated as a normal update, so the
   * room, the other clients and the log stay consistent with each other.
   */
  private applyClientUpdate(conn: Connection, update: Uint8Array): void {
    try {
      Y.decodeUpdate(update);
    } catch {
      throw new MalformedMessage("undecodable update");
    }
    try {
      Y.applyUpdate(this.doc, update, conn);
    } catch (error) {
      throw new MalformedMessage(`update could not be applied: ${errorMessage(error)}`);
    }
    const { store } = this.doc;
    const held =
      (store.pendingStructs?.update.byteLength ?? 0) + (store.pendingDs?.byteLength ?? 0);
    if (held > MAX_PENDING_STRUCT_BYTES) {
      // Dropped: per the comment on the constant, no well-behaved client's
      // data can be in there beyond a moment, and none of it was integrated.
      store.pendingStructs = null;
      store.pendingDs = null;
      throw new MalformedMessage("too many updates with missing dependencies");
    }
  }

  private broadcast(message: Uint8Array, except?: Connection): void {
    for (const conn of this.conns) {
      if (conn !== except && conn.state === "open") conn.send(message);
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === LOAD_ORIGIN || this.status !== "ready") return;
    this.queueForSave(update);
    // Connections still pending get the whole document when they open.
    // The sender already has its own change.
    const sender = this.conns.has(origin as Connection) ? (origin as Connection) : undefined;
    this.broadcast(syncMessage(SYNC_UPDATE, update), sender);
  };

  /** Drops presence that wasn't renewed in time (see RoomAwareness.sweep). */
  sweepAwareness(): void {
    for (const { owner, removal } of this.awareness.sweep()) {
      this.broadcast(awarenessMessage(removal), owner);
    }
  }

  // --- Run state (server-origin changes) --------------------------------

  /** The SQL cell `cellId`, or null if it doesn't exist (deleted) or isn't SQL. */
  private sqlCell(cellId: string): Y.Map<unknown> | null {
    let cell: unknown;
    try {
      cell = this.doc.getMap<unknown>("cells").get(cellId);
    } catch {
      return null; // "cells" was created as some other type by a client
    }
    return cell instanceof Y.Map && cell.get("type") === "sql" ? cell : null;
  }

  runStarted(cellId: string, running: RunningState): void {
    this.doc.transact(() => {
      this.sqlCell(cellId)?.set("running", running);
    }, SERVER_ORIGIN);
  }

  /** Cells the document shows as running: their execution and the run they point at now. */
  runningExecutions(): Map<string, { executionId: string; lastRunId: string | null }> {
    const running = new Map<string, { executionId: string; lastRunId: string | null }>();
    const cells = this.doc.getMap<unknown>("cells");
    cells.forEach((cell, cellId) => {
      if (!(cell instanceof Y.Map) || cell.get("type") !== "sql") return;
      const state = cell.get("running") as { executionId?: unknown } | null | undefined;
      if (state && typeof state === "object" && typeof state.executionId === "string") {
        const lastRunId = cell.get("lastRunId");
        running.set(cellId, {
          executionId: state.executionId,
          lastRunId: typeof lastRunId === "string" ? lastRunId : null,
        });
      }
    });
    return running;
  }

  runFinished(cellId: string, executionId: string, runId: string | null): void {
    this.doc.transact(() => {
      const cell = this.sqlCell(cellId);
      if (!cell) return;
      if (runId !== null) cell.set("lastRunId", runId);
      const running = cell.get("running") as { executionId?: unknown } | null | undefined;
      if (running && typeof running === "object" && running.executionId === executionId) {
        cell.set("running", null);
      }
    }, SERVER_ORIGIN);
  }

  // --- Persistence ------------------------------------------------------

  private queueForSave(update: Uint8Array): void {
    this.pending.push(update);
    this.pendingBytes += update.byteLength;
    this.scheduleFlush(
      this.pendingBytes >= this.timings.flushBytes ? 0 : this.timings.flushIntervalMs,
    );
  }

  private scheduleFlush(delayMs: number): void {
    if (this.status !== "ready" || this.flushing) return; // a running flush reschedules
    if (this.flushTimer) {
      if (delayMs > 0) return; // already scheduled
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delayMs);
  }

  /**
   * Writes everything pending as one merged row. On failure the batch is put
   * back (ahead of anything newer) and retried with backoff; nothing is
   * dropped unless the notebook itself was deleted.
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0 || this.status !== "ready") return Promise.resolve();
    const batch = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    const merged = batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch);
    let failed = false;
    this.lastWriteFailed = false;
    this.flushing = (async () => {
      try {
        await this.store.append(this.id, merged);
        this.logRows++;
        this.retryDelay = 0;
      } catch (error) {
        if (error instanceof NotebookGoneError) {
          this.markDeleted();
          return;
        }
        failed = true;
        this.lastWriteFailed = true;
        this.pending.unshift(merged);
        this.pendingBytes += merged.byteLength;
        this.retryDelay = Math.min(
          this.retryDelay ? this.retryDelay * 2 : this.timings.retryBaseMs,
          this.timings.retryMaxMs,
        );
        log.warn("flush.failed", {
          notebook: this.id,
          retryMs: this.retryDelay,
          error: errorMessage(error),
        });
      }
    })().finally(() => {
      this.flushing = null;
      if (this.status !== "ready") return;
      if (this.pending.length > 0) {
        this.scheduleFlush(failed ? this.retryDelay : this.timings.flushIntervalMs);
      }
      if (!failed && this.logRows >= this.timings.compactAfterRows) void this.compact();
    });
    return this.flushing;
  }

  /**
   * Writes everything pending now. Changes that arrive while a write is in
   * flight are written in another round, up to MAX_FLUSH_ROUNDS; if they keep
   * coming, it returns with them still pending (see hasUnsaved) and the
   * caller tries again later. Rejects only if a write fails.
   */
  async flushAll(): Promise<void> {
    for (let round = 0; round < MAX_FLUSH_ROUNDS; round++) {
      if (this.flushing) await this.flushing;
      if (this.status !== "ready" || this.pending.length === 0) return;
      await this.flush();
      if (this.lastWriteFailed) throw new Error("write failed");
    }
  }

  /**
   * Merges the log into the snapshot (see Store.compact). Failures other
   * than a deleted notebook are logged and left for the next attempt: the
   * log still holds every change, so nothing is lost by not compacting.
   */
  compact(): Promise<void> {
    if (this.compacting) return this.compacting;
    this.compacting = (async () => {
      try {
        const { mergedRows } = await this.store.compact(this.id);
        this.logRows = Math.max(0, this.logRows - mergedRows);
        if (mergedRows > 0) log.info("room.compacted", { notebook: this.id, rows: mergedRows });
      } catch (error) {
        if (error instanceof NotebookGoneError) this.markDeleted();
        else log.warn("compact.failed", { notebook: this.id, error: errorMessage(error) });
      } finally {
        this.compacting = null;
      }
    })();
    return this.compacting;
  }

  // --- Stopping ---------------------------------------------------------

  /**
   * The notebook was deleted: close every socket with 4404 and drop the
   * room without saving anything (there is nowhere to save it).
   */
  markDeleted(): void {
    if (this.status === "deleted" || this.status === "closed") return;
    const wasReady = this.status === "ready" || this.status === "loading";
    this.status = "deleted";
    if (wasReady) log.info("room.deleted", { notebook: this.id });
    this.stop(CloseCode.notebookDeleted, "notebook deleted");
  }

  /** Closes every connection with `code`, discards unsaved work and tells the manager. */
  private stop(code: number, reason: string): void {
    this.pending = [];
    this.pendingBytes = 0;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const conn of this.conns) conn.close(code, reason);
    this.onGone(this);
    this.doc.destroy();
  }

  /** Releases the room after everything was saved. Only the manager calls this. */
  destroy(): void {
    this.status = "closed";
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.doc.destroy();
  }
}
