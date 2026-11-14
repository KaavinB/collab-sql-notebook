"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { useOptionalSession } from "@/components/auth/SessionGate";
import { LoadedNotebook } from "@/components/notebook/NotebookBody";
import { Presence } from "@/components/notebook/Presence";
import { ApiError, createApiClient, type ApiClient, type Notebook, type Role } from "@/lib/api";
import { AwarenessContext } from "@/lib/notebook/awarenessContext";
import { closeConnection, openConnection } from "@/lib/notebook/connections";
import { type NotebookSync, type ProviderFactory, type SyncState } from "@/lib/notebook/sync";

/**
 * A notebook page. The notebook's metadata (title, your role) comes from
 * the API; its content is a Yjs document kept live by the sync server, which
 * also stores it. There is no "save": every edit is sent as it happens.
 */
export function NotebookEditor({
  notebookId,
  api: injected,
  createProvider,
}: {
  notebookId: string;
  api?: ApiClient;
  /** Replaces the WebSocket provider (tests). */
  createProvider?: ProviderFactory;
}) {
  const api = useMemo(() => injected ?? createApiClient(), [injected]);
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sync, setSync] = useState<NotebookSync | null>(null);
  // Bumped to start over with a fresh connection and document (see below).
  const [generation, setGeneration] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getNotebook(notebookId).then(
      (loaded) => !cancelled && setNotebook(loaded),
      (error: unknown) =>
        !cancelled &&
        setLoadError(error instanceof ApiError ? error.message : "Could not load the notebook."),
    );
    return () => {
      cancelled = true;
    };
  }, [api, notebookId]);

  // One live connection per mounted page. Created in an effect (not during
  // render) so React's development double-mount gets a fresh connection.
  // A connection with offline edits outlives the page until they're synced
  // (see connections.ts), so leaving through the app doesn't lose them.
  // A connection stopped as "demoted" (made a viewer while holding edits
  // the server never got) has a document with text that exists only in this
  // tab, and a Yjs document can't drop changes. So the page starts over: the
  // stopped connection is closed (stopped connections never linger) and a
  // new one loads the server's copy, while a notice says what happened.
  useEffect(() => {
    const connection = openConnection(api, notebookId, createProvider);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- publishing an external object
    setSync(connection);
    const unsubscribe = connection.subscribe(() => {
      const state = connection.get();
      if (state.status === "stopped" && state.reason === "demoted") {
        setNotice(state.message);
        setGeneration((n) => n + 1);
      }
    });
    return () => {
      unsubscribe();
      closeConnection(notebookId, connection);
    };
  }, [api, notebookId, createProvider, generation]);

  if (loadError) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-red-600">
          {loadError}
        </p>
        <Link href="/" className="text-sm underline">
          Back to notebooks
        </Link>
      </div>
    );
  }
  if (!notebook || !sync) return <p className="text-zinc-500">Loading notebook…</p>;
  return (
    <>
      {notice && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          data-testid="sync-notice"
        >
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="text-xs underline">
            Dismiss
          </button>
        </div>
      )}
      {/* Keyed by connection, so a new one starts from "Connecting…". */}
      <SyncedNotebook key={generation} api={api} notebook={notebook} sync={sync} />
    </>
  );
}

function useSyncState(sync: NotebookSync): SyncState {
  return useSyncExternalStore(sync.subscribe, sync.get, sync.get);
}

/** Whether edits are at risk (offline, or unconfirmed for too long); re-renders when it changes. */
function useUnsynced(sync: NotebookSync): boolean {
  return useSyncExternalStore(sync.subscribe, sync.hasUnsyncedEdits, sync.hasUnsyncedEdits);
}

/**
 * Whether the sync server has confirmed every edit made in this tab:
 * applied to its copy in memory. It writes them to Postgres shortly after,
 * so this isn't "saved to disk".
 */
function useConfirmed(sync: NotebookSync): boolean {
  const confirmed = () => !sync.hasUnconfirmedEdits();
  return useSyncExternalStore(sync.subscribe, confirmed, confirmed);
}

/** Waits for the first sync, then shows the notebook with its live status. */
function SyncedNotebook({
  api,
  notebook,
  sync,
}: {
  api: ApiClient;
  notebook: Notebook;
  sync: NotebookSync;
}) {
  const state = useSyncState(sync);
  const unsynced = useUnsynced(sync);
  const confirmed = useConfirmed(sync);
  const me = useOptionalSession()?.user;
  const awareness = sync.awareness();
  // Our own entry in the presence list. Yjs never lets a peer's copy replace
  // a client's own awareness state, so this tab sets its own name; the sync
  // server stamps the real one (from the ticket) on what everyone else sees.
  useEffect(() => {
    if (awareness && me) awareness.setLocalStateField("user", { id: me.id, name: me.name });
  }, [awareness, me]);
  // Loaded once the first sync completed; afterwards the notebook stays on
  // screen through disconnects (edits continue offline) and stops.
  const [loaded, setLoaded] = useState(false);
  // "offline" only happens after a first sync: a connection kept from an
  // earlier visit (with offline edits) already has the document to show.
  if (!loaded && (state.status === "live" || state.status === "offline")) setLoaded(true);

  // The page is about to replace this connection (see NotebookEditor), so
  // its document, with edits that weren't saved, isn't shown again.
  if (state.status === "stopped" && state.reason === "demoted") {
    return <p className="text-zinc-500">Reloading the notebook…</p>;
  }
  if (!loaded) {
    if (state.status === "stopped") {
      return (
        <div className="space-y-2">
          <p role="alert" className="text-red-600">
            {state.message}
          </p>
          <Link href="/" className="text-sm underline">
            Back to notebooks
          </Link>
        </div>
      );
    }
    return <p className="text-zinc-500">Connecting…</p>;
  }
  // The live role wins: it changes when an owner changes yours. A stopped
  // connection can't send edits anymore, so the page turns view-only.
  const role: Role = state.role ?? notebook.role;
  const readOnly = role === "viewer" || state.status === "stopped";
  return (
    <AwarenessContext.Provider value={awareness}>
      <LoadedNotebook
        api={api}
        doc={sync.doc}
        notebook={{ ...notebook, role }}
        readOnly={readOnly}
        status={<SyncStatusLabel state={state} unsynced={unsynced} confirmed={confirmed} />}
        banner={<SyncBanner state={state} unsynced={unsynced} />}
        presence={<Presence awareness={awareness} />}
      />
    </AwarenessContext.Provider>
  );
}

/**
 * The connection's status: a word or two for the header's pill, and, when
 * there's more to say, a sentence for the banner under the header (the pill
 * is one truncated line, so explanations and stop reasons don't go there).
 *
 * "Unsynced" means the server hasn't confirmed this tab's edits: on a
 * connection that looks live but hasn't answered in a while (it has
 * probably died; the provider reconnects once it notices, and the edits are
 * sent again). Offline, the banner says whether edits are waiting.
 */
export function describeSync(
  state: SyncState,
  unsynced: boolean,
): { short: string; message: string | null; tone: "calm" | "warn" | "error" } {
  switch (state.status) {
    case "stopped":
      return { short: "Disconnected", message: state.message, tone: "error" };
    case "offline":
      return {
        short: "Offline",
        message: unsynced
          ? "Offline. Unsynced edits will sync when the connection is back."
          : "Offline. Your edits will sync when the connection is back.",
        tone: "warn",
      };
    case "live":
      return unsynced
        ? {
            short: "Unsynced",
            message: "Unsynced. Waiting for the server to confirm your latest edits.",
            tone: "warn",
          }
        : { short: "Live", message: null, tone: "calm" };
    default:
      return { short: "Connecting…", message: null, tone: "calm" };
  }
}

const TONE_TEXT = {
  calm: "text-zinc-500",
  warn: "text-amber-700 dark:text-amber-400",
  error: "text-red-600",
} as const;

/**
 * The pill's text. `data-confirmed` says whether the server has confirmed
 * every edit, including ones sent a moment ago (not shown: it flickers while
 * typing; tests wait on it).
 */
function SyncStatusLabel({
  state,
  unsynced,
  confirmed,
}: {
  state: SyncState;
  unsynced: boolean;
  confirmed: boolean;
}) {
  const { short, tone } = describeSync(state, unsynced);
  return (
    <span
      role="status"
      className={`text-xs ${TONE_TEXT[tone]}`}
      data-testid="sync-status"
      data-confirmed={String(confirmed)}
    >
      {short}
    </span>
  );
}

/** The full sentence, under the header, when the status needs explaining. */
function SyncBanner({ state, unsynced }: { state: SyncState; unsynced: boolean }) {
  const { message, tone } = describeSync(state, unsynced);
  if (!message) return null;
  const colors =
    tone === "error"
      ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
      : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200";
  return (
    // Only a stop is announced from here (as an alert). Offline and unsynced
    // are announced once, by the status pill; announcing this sentence too
    // would read the same change twice.
    <p
      role={tone === "error" ? "alert" : undefined}
      className={`rounded-lg border px-3 py-2 text-sm ${colors}`}
      data-testid="sync-banner"
    >
      {message}
    </p>
  );
}
