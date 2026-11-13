/**
 * Live connections to notebooks, kept past their page when they hold edits
 * the server hasn't received.
 *
 * A notebook page opens a connection and closes it when it unmounts. If the
 * tab was offline and the user edited, closing it would throw those edits
 * away, and leaving through the app (← Notebooks) fires no browser warning.
 * So a connection with unsynced edits lingers instead: it keeps trying to
 * reconnect, and is closed once the server has the edits. Opening the same
 * notebook again picks the lingering connection back up, edits included.
 *
 * "Unsynced" means edits made while the provider knew it was disconnected.
 * A connection that silently died (a half-open socket the provider hasn't
 * noticed yet) isn't detected until its watchdog notices; checking against
 * the server's state vector would close that gap (offline handling is
 * hardened later).
 */
import type { ApiClient } from "@/lib/api";
import { connectNotebook, type NotebookSync, type ProviderFactory } from "@/lib/notebook/sync";

const open = new Set<NotebookSync>();
/** Lingering connections and the notebook each belongs to. */
const lingering = new Map<NotebookSync, string>();
const stopWatching = new Map<NotebookSync, () => void>();
let unloadGuardInstalled = false;

/** True if any notebook in this tab has edits the server hasn't received. */
export function hasUnsyncedEdits(): boolean {
  for (const sync of open) if (sync.hasUnsyncedEdits()) return true;
  for (const sync of lingering.keys()) if (sync.hasUnsyncedEdits()) return true;
  return false;
}

/** Warns before the tab closes or reloads while edits haven't reached the server. */
function installUnloadGuard(): void {
  if (unloadGuardInstalled || typeof window === "undefined") return;
  unloadGuardInstalled = true;
  window.addEventListener("beforeunload", (event) => {
    if (hasUnsyncedEdits()) event.preventDefault();
  });
}

export function openConnection(
  api: ApiClient,
  notebookId: string,
  createProvider?: ProviderFactory,
): NotebookSync {
  installUnloadGuard();
  const kept = [...lingering].find(([, id]) => id === notebookId)?.[0];
  if (kept) {
    lingering.delete(kept);
    stopWatching.get(kept)?.();
    stopWatching.delete(kept);
    open.add(kept);
    return kept;
  }
  const sync = connectNotebook(api, notebookId, createProvider);
  open.add(sync);
  return sync;
}

export function closeConnection(notebookId: string, sync: NotebookSync): void {
  open.delete(sync);
  const done = () => !sync.hasUnsyncedEdits() || sync.get().status === "stopped";
  if (done()) {
    sync.destroy();
    return;
  }
  lingering.set(sync, notebookId);
  const unsubscribe = sync.subscribe(() => {
    // Synced: the server has everything. Stopped: it never will (no access,
    // deleted, signed out), and keeping it wouldn't help.
    if (sync.get().status === "live" ? !sync.hasUnsyncedEdits() : done()) {
      lingering.delete(sync);
      unsubscribe();
      stopWatching.delete(sync);
      sync.destroy();
    }
  });
  stopWatching.set(sync, unsubscribe);
}

/** For tests: forget every connection. */
export function resetConnections(): void {
  for (const sync of [...open, ...lingering.keys()]) sync.destroy();
  open.clear();
  lingering.clear();
  stopWatching.clear();
}
