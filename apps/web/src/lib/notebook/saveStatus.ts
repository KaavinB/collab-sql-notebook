import { ApiError } from "@/lib/api";
import type { SaveStatus } from "@/lib/notebook/autosave";

export interface SaveState {
  status: SaveStatus;
  /** Set when status is "error". */
  error?: unknown;
  /** True when retrying can't help, so autosave has stopped retrying. */
  permanent?: boolean;
}

/**
 * Client errors that retrying can't fix: the notebook was deleted (404), the
 * snapshot is too large (413), the request is invalid (400). 408 and 429 are
 * 4xx but temporary (a proxy timeout, rate limiting), so they're retried.
 */
export function isPermanentSaveError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

export function saveLabel(state: SaveState): string {
  switch (state.status) {
    case "saved":
      return "Saved";
    case "pending":
      return "Unsaved changes";
    case "saving":
      return "Saving…";
    case "error": {
      if (!state.permanent) return "Not saved — retrying";
      const reason = state.error instanceof ApiError ? state.error.message : "unknown error";
      return `Not saved: ${reason}`;
    }
  }
}

/**
 * A tiny external store for the save state. Components subscribe with
 * useSyncExternalStore, so a status change re-renders only the label, not
 * every cell and result table in the notebook.
 */
export function createSaveStateStore() {
  let state: SaveState = { status: "saved" };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: SaveState) {
      state = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type SaveStateStore = ReturnType<typeof createSaveStateStore>;
