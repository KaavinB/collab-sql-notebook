/**
 * Owns every room: creates them on demand, shares one load between everyone
 * who arrives while a room is loading, unloads them when they empty, and
 * applies the API's events to them.
 *
 * Unloading: when the last connection leaves, the room waits a grace period
 * (a page reload reconnects within it, so the document isn't thrown away and
 * reloaded), then writes what's pending, compacts the log into the snapshot
 * and forgets the room. If someone connects during any of that, the room
 * simply stays: its document in memory is still the latest.
 */
import type { WebSocket } from "ws";

import { STOPPED_MESSAGE, suggestionState } from "./ai.ts";
import { Connection } from "./connection.ts";
import { errorMessage, log } from "./log.ts";
import type { NotebookEvent } from "./notify.ts";
import { CloseCode } from "./protocol.ts";
import { DEFAULT_TIMINGS, Room, type RoomTimings } from "./room.ts";
import { AI_STALE_AFTER_MS, type Store } from "./store.ts";
import type { Ticket } from "./ticket.ts";

export interface ManagerTimings extends RoomTimings {
  /** How long an empty room stays loaded before it's saved and unloaded. */
  unloadGraceMs: number;
  /** Retry delay for an unload whose final save failed. */
  unloadRetryMs: number;
  /** How often stale presence is swept from every room. */
  awarenessSweepMs: number;
  /**
   * How long after the AI starts thinking about a cell (or a reload finds it
   * still thinking) its request is checked again, in case it died.
   */
  aiStaleCheckMs: number;
}

// After a lock's expiry, wait this much longer before re-checking: the
// expiry comes from the database's clock, the timer from this server's.
const EXPIRY_CHECK_SLACK_MS = 2_000;

export const DEFAULT_MANAGER_TIMINGS: ManagerTimings = {
  ...DEFAULT_TIMINGS,
  unloadGraceMs: 10_000,
  unloadRetryMs: 5_000,
  awarenessSweepMs: 5_000,
  // By then the request counts as stale by the database's clock (same slack
  // as for run locks), so the check settles it if it's still running.
  aiStaleCheckMs: AI_STALE_AFTER_MS + EXPIRY_CHECK_SLACK_MS,
};

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private stopping = false;
  private readonly sweepTimer: NodeJS.Timeout;
  /** Re-checks scheduled for when a run's lock expires or an AI request goes stale. */
  private readonly expiryChecks = new Set<NodeJS.Timeout>();
  /**
   * Per notebook, the tail of its chain of AI changes. Applying an AI event
   * can mean reading Postgres first (a suggestion's row), so without the
   * chain a later event (that suggestion being resolved) could be applied
   * before an earlier one finishes, and the resolved suggestion would
   * reappear. Reconciliation joins the same chain.
   */
  private readonly aiChains = new Map<string, Promise<void>>();

  private readonly store: Store;
  private readonly timings: ManagerTimings;

  constructor(store: Store, timings: ManagerTimings = DEFAULT_MANAGER_TIMINGS) {
    this.store = store;
    this.timings = timings;
    this.sweepTimer = setInterval(() => {
      for (const room of this.rooms.values()) if (room.status === "ready") room.sweepAwareness();
    }, timings.awarenessSweepMs);
    this.sweepTimer.unref();
  }

  /** The room for `notebookId`, loading it if needed. Concurrent callers share one load. */
  private acquire(notebookId: string): Room {
    const existing = this.rooms.get(notebookId);
    if (existing) {
      this.cancelUnload(existing);
      return existing;
    }
    const room = new Room(notebookId, this.store, this.timings, (gone) => {
      this.cancelUnload(gone);
      if (this.rooms.get(gone.id) === gone) this.rooms.delete(gone.id);
    });
    this.rooms.set(notebookId, room);
    // A loaded document may still show runs whose end was never reported,
    // and AI requests whose outcome was never reported.
    room.ready.then(
      () => {
        void this.reconcileRuns(room);
        this.reconcileAiLater(room);
      },
      () => {},
    );
    return room;
  }

  /**
   * A socket that passed the ticket check. It joins its room at once (so an
   * access change or deletion arriving now reaches it), then opens when the
   * room has loaded and the user's current membership matches the ticket.
   */
  connect(ws: WebSocket, ticket: Ticket): void {
    if (this.stopping) {
      ws.close(CloseCode.restart, "server restarting");
      return;
    }
    const room = this.acquire(ticket.notebookId);
    const conn = new Connection(ws, ticket);
    room.conns.add(conn);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        conn.close(CloseCode.malformed, "text frames are not part of the protocol");
        return;
      }
      conn.receive(toBytes(data));
    });
    ws.on("close", (code) => {
      conn.closed();
      room.remove(conn);
      log.info("conn.closed", { notebook: room.id, user: ticket.userId, code });
      this.scheduleUnload(room, this.timings.unloadGraceMs);
    });
    void this.authorize(room, conn);
  }

  private async authorize(room: Room, conn: Connection): Promise<void> {
    const { ticket } = conn;
    let role;
    try {
      [role] = await Promise.all([
        this.store.memberRole(ticket.notebookId, ticket.userId),
        room.ready,
      ]);
    } catch (error) {
      // A failed load has already closed the room's sockets with 1011.
      if (conn.state === "pending") {
        log.error("conn.authorize_failed", {
          notebook: room.id,
          error: errorMessage(error),
        });
        conn.close(CloseCode.serverError, "server error");
      }
      return;
    }
    if (conn.state !== "pending") return;
    if (room.status === "deleted") {
      conn.close(CloseCode.notebookDeleted, "notebook deleted");
    } else if (role !== ticket.role) {
      // Removed, or the role changed since the ticket was issued. The client
      // fetches a new ticket; the API decides whether access remains.
      log.info("conn.access_changed", { notebook: room.id, user: ticket.userId });
      conn.close(CloseCode.accessChanged, "access changed");
    } else if (room.status === "ready") {
      room.open(conn);
      log.info("conn.opened", { notebook: room.id, user: ticket.userId, role: ticket.role });
    } else {
      conn.close(CloseCode.serverError, "server error");
    }
  }

  // --- Unloading --------------------------------------------------------

  private cancelUnload(room: Room): void {
    if (room.unloadTimer) clearTimeout(room.unloadTimer);
    room.unloadTimer = null;
  }

  private scheduleUnload(room: Room, delayMs: number): void {
    if (this.stopping || !room.idle || room.unloadTimer || room.unloading) return;
    if (this.rooms.get(room.id) !== room) return;
    room.unloadTimer = setTimeout(() => void this.unload(room), delayMs);
  }

  private async unload(room: Room): Promise<void> {
    room.unloadTimer = null;
    if (!room.idle || this.stopping) return;
    try {
      await room.ready;
    } catch {
      return; // a failed load already removed the room
    }
    if (room.status !== "ready") return;
    room.unloading = true;
    let saved = false;
    try {
      await room.flushAll();
      await room.compact();
      saved = true;
    } catch (error) {
      log.warn("room.unload_failed", { notebook: room.id, error: errorMessage(error) });
    } finally {
      room.unloading = false;
    }
    if (room.status !== "ready" || !room.idle) return; // deleted, or someone came back
    if (saved && !room.hasUnsaved) {
      this.rooms.delete(room.id);
      room.destroy();
      log.info("room.unloaded", { notebook: room.id });
      return;
    }
    // New changes arrived (a NOTIFY) or the save failed: go around again.
    this.scheduleUnload(room, saved ? 0 : this.timings.unloadRetryMs);
  }

  // --- API events -------------------------------------------------------

  handleEvent(event: NotebookEvent): void {
    switch (event.type) {
      case "run_started":
        void this.withRoom(event.notebookId, (room) =>
          room.runStarted(event.cellId, {
            executionId: event.executionId,
            by: event.userName,
            startedAt: event.startedAt,
            expiresAt: event.expiresAt,
          }),
        );
        if (event.expiresAt) this.checkWhenExpired(event.notebookId, event.expiresAt);
        break;
      case "run_finished":
        void this.withRoom(event.notebookId, (room) =>
          room.runFinished(event.cellId, event.executionId, event.runId),
        );
        break;
      case "access_changed": {
        const room = this.rooms.get(event.notebookId);
        if (!room) return;
        for (const conn of room.conns) {
          if (conn.ticket.userId === event.userId) {
            conn.close(CloseCode.accessChanged, "access changed");
          }
        }
        log.info("notify.access_changed", { notebook: event.notebookId, user: event.userId });
        break;
      }
      case "notebook_deleted":
        this.rooms.get(event.notebookId)?.markDeleted();
        break;
      case "ai_started": {
        const { cellId, requestId, kind, userName } = event;
        this.chainAi(event.notebookId, () =>
          this.withRoom(event.notebookId, (room) =>
            room.aiStarted(cellId, {
              status: "thinking",
              requestId,
              kind,
              by: userName,
              // The event doesn't carry a time; it arrives as the request starts.
              startedAt: new Date().toISOString(),
            }),
          ),
        );
        this.checkAiWhenStale(event.notebookId);
        break;
      }
      case "ai_suggestion":
        this.chainAi(event.notebookId, () =>
          this.withRoom(event.notebookId, async (room) => {
            const row = await this.store.aiSuggestion(room.id, event.suggestionId);
            if (room.status !== "ready") return;
            if (!row || row.cellId !== event.cellId || row.requestId !== event.requestId) {
              // Left thinking; reconciliation settles it from the tables later.
              log.warn("ai.unknown_suggestion", {
                notebook: room.id,
                cell: event.cellId,
                suggestion: event.suggestionId,
              });
              return;
            }
            // Already accepted or rejected before it could be shown: its
            // ai_resolved only clears a suggestion state, so settle the
            // thinking state here, as reconciliation would.
            if (row.status !== "pending") {
              room.aiSettle(event.cellId, event.requestId, null);
              return;
            }
            room.aiOutcome(event.cellId, suggestionState(row, room.aiAskedBy(event.cellId)));
          }),
        );
        break;
      case "ai_failed":
        this.chainAi(event.notebookId, () =>
          this.withRoom(event.notebookId, (room) =>
            room.aiOutcome(event.cellId, {
              status: "failed",
              requestId: event.requestId,
              message: event.message,
            }),
          ),
        );
        break;
      case "ai_resolved":
        this.chainAi(event.notebookId, () =>
          this.withRoom(event.notebookId, (room) =>
            room.aiResolved(event.cellId, event.suggestionId),
          ),
        );
        break;
    }
  }

  /** Runs `task` after every AI change already queued for the notebook (see aiChains). */
  private chainAi(notebookId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.aiChains.get(notebookId) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => {
      log.warn("ai.apply_failed", { notebook: notebookId, error: errorMessage(error) });
    });
    this.aiChains.set(notebookId, next);
    void next.then(() => {
      if (this.aiChains.get(notebookId) === next) this.aiChains.delete(notebookId);
    });
    return next;
  }

  /**
   * Re-checks a notebook's AI states once a request just started could be
   * stale. If the API process answering it died, no outcome ever comes, and
   * a room that stays loaded would show the AI thinking forever.
   */
  private checkAiWhenStale(notebookId: string): void {
    const timer = setTimeout(() => {
      this.expiryChecks.delete(timer);
      const room = this.rooms.get(notebookId);
      if (room && !this.stopping) this.reconcileAiLater(room);
    }, this.timings.aiStaleCheckMs);
    timer.unref();
    this.expiryChecks.add(timer);
  }

  private reconcileAiLater(room: Room): void {
    void this.chainAi(room.id, () => this.reconcileAi(room));
  }

  /**
   * Settles AI states whose events were missed (the listener was
   * reconnecting, or the API process died mid-request), from the tables:
   * - thinking: the request's suggestion if it has one (cleared instead if
   *   that was already accepted or rejected); otherwise, if the request
   *   isn't running anymore or started too long ago, a failure;
   * - suggestion: cleared once its row is no longer pending (or is gone).
   * Runs when a room loads, after the listener reconnects, and when a
   * request started in this room could have gone stale.
   */
  async reconcileAi(room: Room): Promise<void> {
    if (room.status !== "ready") return;
    const states = room.aiStates();
    const requestIds: string[] = [];
    const suggestionIds: string[] = [];
    for (const ref of states.values()) {
      if (ref.status === "thinking") requestIds.push(ref.requestId);
      if (ref.status === "suggestion" && ref.suggestionId) suggestionIds.push(ref.suggestionId);
    }
    if (requestIds.length === 0 && suggestionIds.length === 0) return;
    room.holds++;
    try {
      const outcomes = await this.store.aiOutcomes(room.id, requestIds, suggestionIds);
      if (room.status !== "ready") return;
      let stillThinking = false;
      for (const [cellId, ref] of states) {
        if (ref.status === "thinking") {
          const suggestion = outcomes.byRequest.get(ref.requestId);
          const request = outcomes.requests.get(ref.requestId);
          let settled = false;
          if (suggestion && suggestion.cellId === cellId) {
            const state =
              suggestion.status === "pending"
                ? suggestionState(suggestion, room.aiAskedBy(cellId))
                : null;
            settled = room.aiSettle(cellId, ref.requestId, state);
          } else if (!request || request.status !== "running" || request.stale) {
            settled = room.aiSettle(cellId, ref.requestId, {
              status: "failed",
              requestId: ref.requestId,
              message: STOPPED_MESSAGE,
            });
          } else {
            stillThinking = true; // running and recent: left as it is
          }
          if (settled) log.info("ai.reconciled", { notebook: room.id, cell: cellId });
        } else if (ref.status === "suggestion" && ref.suggestionId) {
          if (outcomes.suggestions.get(ref.suggestionId) !== "pending") {
            room.aiResolved(cellId, ref.suggestionId);
            log.info("ai.reconciled", { notebook: room.id, cell: cellId });
          }
        }
      }
      // A request found running (say, after a reload) gets the same re-check
      // as one whose start this server saw, or a request that then dies would
      // show the AI thinking for as long as the room stays loaded.
      if (stillThinking) this.checkAiWhenStale(room.id);
    } catch (error) {
      log.warn("ai.reconcile_failed", { notebook: room.id, error: errorMessage(error) });
    } finally {
      room.holds--;
      if (room.idle) this.scheduleUnload(room, 0);
    }
  }

  /**
   * Runs `change` on the room, loading it first if nobody has it open. The
   * change goes through the normal save path; a room loaded only for this is
   * then saved, compacted and unloaded right away.
   *
   * Events for one notebook are applied in arrival order: each one waits on
   * the same `ready` promise, and promise callbacks run in the order they
   * were registered.
   */
  private async withRoom(
    notebookId: string,
    change: (room: Room) => unknown | Promise<unknown>,
  ): Promise<void> {
    if (this.stopping) return;
    const room = this.acquire(notebookId);
    room.holds++;
    try {
      await room.ready;
      // The room stays held while an asynchronous change reads Postgres.
      if (room.status === "ready") await change(room);
    } catch (error) {
      log.warn("notify.apply_failed", { notebook: notebookId, error: errorMessage(error) });
    } finally {
      room.holds--;
      this.scheduleUnload(room, 0);
    }
  }

  /**
   * Re-checks every loaded room and open socket against the database, for
   * when access_changed or notebook_deleted events may have been missed (the
   * listener was reconnecting). Same outcome as the events would have had:
   * 4404 for a deleted notebook, 4403 for a member removed or whose role
   * changed.
   */
  async recheckAccess(): Promise<void> {
    log.info("access.recheck", { rooms: this.rooms.size });
    await Promise.all(
      [...this.rooms.values()].map(async (room) => {
        await this.recheckRoom(room);
        await this.reconcileRuns(room);
        await this.chainAi(room.id, () => this.reconcileAi(room));
      }),
    );
  }

  /**
   * Re-checks a notebook's runs shortly after a run's lock expires. If the
   * API process running it died, no run_finished ever comes, and without
   * this a room that stays loaded would show the run forever. (A room that
   * isn't loaded by then is reconciled when it next loads.)
   */
  private checkWhenExpired(notebookId: string, expiresAt: string): void {
    const delay = Math.max(0, Date.parse(expiresAt) - Date.now()) + EXPIRY_CHECK_SLACK_MS;
    const timer = setTimeout(() => {
      this.expiryChecks.delete(timer);
      const room = this.rooms.get(notebookId);
      if (room && !this.stopping) void this.reconcileRuns(room);
    }, delay);
    timer.unref();
    this.expiryChecks.add(timer);
  }

  /**
   * Settles cells the document shows as running whose execution is over,
   * for when its run_finished was missed: the listener was reconnecting, or
   * the API process running it died (its lock then expires). Each such cell
   * gets the run its execution stored, if any, and stops showing as running.
   * Runs when a room loads and after the listener reconnects.
   */
  async reconcileRuns(room: Room): Promise<void> {
    if (room.status !== "ready") return;
    const running = room.runningExecutions();
    if (running.size === 0) return;
    room.holds++;
    try {
      const cells = [...running.values()];
      const { live, runs, times } = await this.store.executionOutcomes(
        room.id,
        cells.map((cell) => cell.executionId),
        cells.flatMap((cell) => (cell.lastRunId ? [cell.lastRunId] : [])),
      );
      if (room.status !== "ready") return;
      for (const [cellId, { executionId, lastRunId }] of running) {
        if (live.has(executionId)) continue;
        // Only a newer result may replace the one the cell shows: while the
        // listener was down, someone may already have run the cell again
        // (their client points it at that later run itself).
        const stored = runs.get(executionId);
        const shownAt = lastRunId ? times.get(lastRunId) : undefined;
        const newer = stored && (shownAt === undefined || stored.at > shownAt);
        room.runFinished(cellId, executionId, newer ? stored.id : null);
        log.info("run.reconciled", { notebook: room.id, cell: cellId, repointed: Boolean(newer) });
      }
    } catch (error) {
      log.warn("run.reconcile_failed", { notebook: room.id, error: errorMessage(error) });
    } finally {
      room.holds--;
      if (room.idle) this.scheduleUnload(room, 0);
    }
  }

  private async recheckRoom(room: Room): Promise<void> {
    try {
      if (!(await this.store.notebookExists(room.id))) {
        room.markDeleted();
        return;
      }
      const roles = await this.store.memberRoles(room.id);
      for (const conn of room.conns) {
        if (conn.state !== "closed" && roles.get(conn.ticket.userId) !== conn.ticket.role) {
          log.info("conn.access_changed", { notebook: room.id, user: conn.ticket.userId });
          conn.close(CloseCode.accessChanged, "access changed");
        }
      }
    } catch (error) {
      log.warn("access.recheck_failed", { notebook: room.id, error: errorMessage(error) });
    }
  }

  // --- Shutdown ---------------------------------------------------------

  /**
   * Stops taking connections and events, closes every socket with 1012
   * (service restart: clients reconnect) and saves and compacts every room.
   * Rooms whose save keeps failing are logged; their clients still hold the
   * changes and send them again when they reconnect.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.sweepTimer);
    for (const timer of this.expiryChecks) clearTimeout(timer);
    this.expiryChecks.clear();
    const rooms = [...this.rooms.values()];
    for (const room of rooms) {
      this.cancelUnload(room);
      for (const conn of room.conns) conn.close(CloseCode.restart, "server restarting");
    }
    await Promise.all(
      rooms.map(async (room) => {
        try {
          await room.ready;
        } catch {
          return;
        }
        if (room.status !== "ready") return;
        try {
          await room.flushAll();
          await room.compact();
          if (room.hasUnsaved) throw new Error("changes kept arriving");
        } catch (error) {
          log.error("shutdown.save_failed", { notebook: room.id, error: errorMessage(error) });
        }
        room.destroy();
        this.rooms.delete(room.id);
      }),
    );
  }
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}
