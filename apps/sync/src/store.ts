/**
 * Postgres persistence for notebook documents: snapshot + append-only log.
 *
 *   notebook_snapshots(notebook_id, state)   the compacted document, one row
 *   notebook_updates(id, notebook_id, update) batches appended since then
 *
 * A document is the snapshot with every log row applied. Yjs updates commute
 * and applying one twice is harmless, so row order only matters for speed.
 *
 * The sync server appends to the log and compacts it into the snapshot.
 * Alembic owns the schema; this file only reads and writes rows.
 */
import pg from "pg";
import * as Y from "yjs";

import type { Role } from "./ticket.ts";

export class NotebookGoneError extends Error {
  constructor() {
    super("notebook no longer exists");
  }
}

/** Postgres' code for a foreign-key violation: the notebook row is gone. */
const FOREIGN_KEY_VIOLATION = "23503";

function isForeignKeyViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === FOREIGN_KEY_VIOLATION;
}

export interface LoadedDocument {
  /** The snapshot and log merged into one update; null for a new, empty notebook. */
  state: Uint8Array | null;
  /** How many log rows were merged, so the room knows when to compact. */
  logRows: number;
}

export interface CompactResult {
  /** Log rows merged into the snapshot and deleted. */
  mergedRows: number;
}

export class Store {
  readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /**
   * The notebook's document, or null if the notebook doesn't exist.
   *
   * One REPEATABLE READ transaction: the snapshot and the log are read from
   * the same point in time. Otherwise a compaction committing between the two
   * reads would leave this load with the old snapshot and an already-emptied
   * log, and the merged edits would be missing from the room.
   */
  async load(notebookId: string): Promise<LoadedDocument | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const exists = await client.query("SELECT 1 FROM notebooks WHERE id = $1", [notebookId]);
      if (exists.rowCount === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      const snapshot = await client.query<{ state: Buffer }>(
        "SELECT state FROM notebook_snapshots WHERE notebook_id = $1",
        [notebookId],
      );
      const log = await client.query<{ update: Buffer }>(
        'SELECT "update" FROM notebook_updates WHERE notebook_id = $1 ORDER BY id',
        [notebookId],
      );
      await client.query("COMMIT");
      const parts: Uint8Array[] = [];
      if (snapshot.rows[0]) parts.push(snapshot.rows[0].state);
      for (const row of log.rows) parts.push(row.update);
      const state =
        parts.length === 0 ? null : parts.length === 1 ? parts[0]! : Y.mergeUpdates(parts);
      return { state, logRows: log.rows.length };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The user's current role in the notebook, null if they aren't a member.
   * Checked when a socket connects: the ticket's role was right when it was
   * issued, but access can change in the up to 60 seconds before it's used.
   */
  async memberRole(notebookId: string, userId: string): Promise<Role | null> {
    const result = await this.pool.query<{ role: Role }>(
      "SELECT role FROM notebook_members WHERE notebook_id = $1 AND user_id = $2",
      [notebookId, userId],
    );
    return result.rows[0]?.role ?? null;
  }

  /** Every member's role in the notebook, by user ID. */
  async memberRoles(notebookId: string): Promise<Map<string, Role>> {
    const result = await this.pool.query<{ user_id: string; role: Role }>(
      "SELECT user_id, role FROM notebook_members WHERE notebook_id = $1",
      [notebookId],
    );
    return new Map(result.rows.map((row) => [row.user_id, row.role]));
  }

  async notebookExists(notebookId: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM notebooks WHERE id = $1", [notebookId]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Appends one batch of updates to the log. Throws NotebookGoneError if the
   * notebook was deleted (the foreign key fails), any other error as is.
   *
   * A single INSERT, so it needs no explicit lock: its foreign-key check
   * takes a share lock on the notebook row, which waits for a concurrent
   * DELETE of the notebook (holding that row's lock) and then fails cleanly.
   */
  async append(notebookId: string, update: Uint8Array): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO notebook_updates (notebook_id, "update") VALUES ($1, $2)',
        [notebookId, Buffer.from(update.buffer, update.byteOffset, update.byteLength)],
      );
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new NotebookGoneError();
      throw error;
    }
  }

  /**
   * Merges the log into the snapshot, in one transaction:
   *   1. lock the notebook row (FOR UPDATE), the same order DELETE /notebooks
   *      uses (the notebook row, then its rows by cascade), so the two can't
   *      deadlock;
   *   2. read the snapshot and the log rows;
   *   3. apply them all into a fresh document and upsert it as the snapshot;
   *   4. delete exactly the rows it read.
   *
   * Step 4 deletes by the IDs read in step 2, not "id <= max": a batch from
   * a concurrent append can get a smaller ID yet commit after step 2's read,
   * and a range delete would drop it without it ever being merged.
   *
   * Throws NotebookGoneError if the notebook no longer exists.
   */
  async compact(notebookId: string): Promise<CompactResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT id FROM notebooks WHERE id = $1 FOR UPDATE", [
        notebookId,
      ]);
      if (locked.rowCount === 0) throw new NotebookGoneError();
      const log = await client.query<{ id: string; update: Buffer }>(
        'SELECT id, "update" FROM notebook_updates WHERE notebook_id = $1 ORDER BY id',
        [notebookId],
      );
      if (log.rows.length === 0) {
        await client.query("COMMIT");
        return { mergedRows: 0 };
      }
      const snapshot = await client.query<{ state: Buffer }>(
        "SELECT state FROM notebook_snapshots WHERE notebook_id = $1",
        [notebookId],
      );
      const doc = new Y.Doc();
      try {
        if (snapshot.rows[0]) Y.applyUpdate(doc, snapshot.rows[0].state);
        for (const row of log.rows) Y.applyUpdate(doc, row.update);
        const state = Y.encodeStateAsUpdate(doc);
        await client.query(
          `INSERT INTO notebook_snapshots (notebook_id, state) VALUES ($1, $2)
           ON CONFLICT (notebook_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
          [notebookId, Buffer.from(state.buffer, state.byteOffset, state.byteLength)],
        );
      } finally {
        doc.destroy();
      }
      // Saved content counts as updating the notebook: the notebook list is
      // ordered by updated_at. Only at compaction, so it can lag the last
      // edit by as long as a room stays open.
      await client.query("UPDATE notebooks SET updated_at = now() WHERE id = $1", [notebookId]);
      const ids = log.rows.map((row) => row.id);
      await client.query(
        "DELETE FROM notebook_updates WHERE notebook_id = $1 AND id = ANY($2::bigint[])",
        [notebookId, ids],
      );
      await client.query("COMMIT");
      return { mergedRows: ids.length };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
