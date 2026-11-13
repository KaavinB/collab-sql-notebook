/**
 * Saves the notebook's Yjs document to the API after edits (D7, provisional).
 *
 * Phase 1 has one writer, so it saves the whole document
 * (`Y.encodeStateAsUpdate`) a short while after the last change. Phase 2
 * replaces this with the sync server, which persists updates itself.
 *
 * - Saves never overlap: if the document changes while a save is in flight,
 *   one more save runs after it finishes, with the latest state.
 * - A failed save is retried with backoff until it succeeds or the autosave
 *   is disposed, so an edit isn't lost because the API restarted.
 * - Attach it only after the stored snapshot has been applied to the doc.
 *   Otherwise an early save would upload a near-empty document over the
 *   stored one.
 */
import * as Y from "yjs";

export type SaveStatus = "saved" | "pending" | "saving" | "error";

/** Origin for transactions that must not trigger a save (e.g. applying the loaded snapshot). */
export const LOAD_ORIGIN = Symbol("load");

const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export interface AutosaveOptions {
  save: (state: Uint8Array) => Promise<void>;
  debounceMs?: number;
  onStatus?: (status: SaveStatus, error?: unknown) => void;
}

export interface Autosave {
  /**
   * Saves now if there are unsaved changes. Resolves once everything is
   * saved; rejects with the save error if the latest state could not be
   * saved (retries continue in the background).
   */
  flush(): Promise<void>;
  /** Stops saving. Unsaved changes are dropped, so `await flush()` first. */
  dispose(): void;
}

export function attachAutosave(doc: Y.Doc, options: AutosaveOptions): Autosave {
  const { save, debounceMs = 1000, onStatus } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = RETRY_INITIAL_MS;
  let dirty = false;
  let lastError: unknown = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  const schedule = (delayMs: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delayMs);
  };

  /** Saves until the document is clean or a save fails. Never throws. */
  const run = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      while (dirty && !disposed) {
        dirty = false;
        onStatus?.("saving");
        try {
          await save(Y.encodeStateAsUpdate(doc));
        } catch (error) {
          // Still unsaved: retry later with backoff (an edit also retries).
          dirty = true;
          lastError = error;
          onStatus?.("error", error);
          if (!disposed) schedule(retryDelay);
          retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
          return;
        }
        lastError = null;
        retryDelay = RETRY_INITIAL_MS;
      }
      if (!disposed && !dirty) onStatus?.("saved");
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin === LOAD_ORIGIN || disposed) return;
    dirty = true;
    onStatus?.("pending");
    schedule(debounceMs);
  };

  doc.on("update", onUpdate);

  return {
    async flush() {
      if (inFlight) await inFlight;
      if (dirty) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        await run();
      }
      if (dirty) throw lastError ?? new Error("notebook changes are not saved");
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      doc.off("update", onUpdate);
    },
  };
}
