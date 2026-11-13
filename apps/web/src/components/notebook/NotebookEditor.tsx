"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";

import { AiAssist, type FailedRun } from "@/components/notebook/AiAssist";
import { CellFrame, MarkdownCellBody, RunButton, SqlCellBody } from "@/components/notebook/Cells";
import {
  ChartCellBody,
  type ChartSource,
  type SqlCellOption,
} from "@/components/notebook/ChartCell";
import { useOptionalSession } from "@/components/auth/SessionGate";
import { Presence } from "@/components/notebook/Presence";
import { useRuns, type RunState } from "@/components/notebook/useRuns";
import { SharePanel } from "@/components/sharing/SharePanel";
import { ApiError, createApiClient, type ApiClient, type Notebook, type Role } from "@/lib/api";
import { AwarenessContext } from "@/lib/notebook/awarenessContext";
import { writeChartConfig, type ChartConfig } from "@/lib/notebook/chart";
import {
  appendCell,
  chartMap,
  deleteCell,
  isRunActive,
  moveCell,
  setLastRunIfUnchanged,
  type CellType,
  type CellView,
} from "@/lib/notebook/doc";
import { closeConnection, openConnection } from "@/lib/notebook/connections";
import { type NotebookSync, type ProviderFactory, type SyncState } from "@/lib/notebook/sync";
import { useCells } from "@/lib/notebook/useCells";

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
  useEffect(() => {
    const connection = openConnection(api, notebookId, createProvider);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- publishing an external object
    setSync(connection);
    return () => closeConnection(notebookId, connection);
  }, [api, notebookId, createProvider]);

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
  return <SyncedNotebook api={api} notebook={notebook} sync={sync} />;
}

function useSyncState(sync: NotebookSync): SyncState {
  return useSyncExternalStore(sync.subscribe, sync.get, sync.get);
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
        status={<SyncStatusLabel state={state} />}
        presence={<Presence awareness={awareness} />}
      />
    </AwarenessContext.Provider>
  );
}

function SyncStatusLabel({ state }: { state: SyncState }) {
  if (state.status === "stopped") {
    return (
      <span role="alert" className="ml-auto text-xs text-red-600" data-testid="sync-status">
        {state.message}
      </span>
    );
  }
  const label =
    state.status === "live"
      ? "Live"
      : state.status === "offline"
        ? "Offline. Your edits will sync when the connection is back."
        : "Connecting…";
  return (
    <span
      role="status"
      className={`ml-auto text-xs ${state.status === "offline" ? "text-amber-700" : "text-zinc-500"}`}
      data-testid="sync-status"
    >
      {label}
    </span>
  );
}

function LoadedNotebook({
  api,
  doc,
  notebook,
  readOnly,
  status,
  presence,
}: {
  api: ApiClient;
  doc: Y.Doc;
  notebook: Notebook;
  /** Viewers read; the API refuses their writes and the sync server drops their edits. */
  readOnly: boolean;
  status: React.ReactNode;
  presence: React.ReactNode;
}) {
  const cells = useCells(doc);
  const { runs, loadFailures, cellStates, ensureRun, runCell } = useRuns(api, notebook.id);
  // SQL cells a chart can draw from, labelled by their position. (Not by their
  // text: this list only updates on structural changes, not while typing.)
  const sqlCells = useMemo(
    () =>
      cells.flatMap((cell, index) =>
        cell.type === "sql" ? [{ id: cell.id, label: `SQL cell ${index + 1}` }] : [],
      ),
    [cells],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/" className="text-sm text-zinc-500 hover:underline">
          ← Notebooks
        </Link>
        {readOnly && (
          <span
            className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            data-testid="view-only"
          >
            View only
          </span>
        )}
        {status}
      </div>
      {presence}
      {readOnly ? (
        <h1 className="text-2xl font-semibold tracking-tight">{notebook.title}</h1>
      ) : (
        <TitleEditor api={api} notebook={notebook} />
      )}
      <SharePanel api={api} notebook={notebook} />

      {cells.length === 0 && (
        <p className="text-sm text-zinc-500">
          {readOnly ? "This notebook is empty." : "This notebook is empty. Add a cell to start."}
        </p>
      )}
      {cells.map((cell, index) => (
        <Cell
          key={cell.id}
          api={api}
          notebookId={notebook.id}
          doc={doc}
          cell={cell}
          index={index}
          count={cells.length}
          runs={runs}
          loadFailures={loadFailures}
          cellStates={cellStates}
          ensureRun={ensureRun}
          runCell={runCell}
          sqlCells={sqlCells}
          cells={cells}
          readOnly={readOnly}
        />
      ))}

      {!readOnly && <AddCellButtons onAdd={(type) => appendCell(doc, type)} />}
    </div>
  );
}

function Cell({
  api,
  notebookId,
  doc,
  cell,
  index,
  count,
  runs,
  loadFailures,
  cellStates,
  ensureRun,
  runCell,
  sqlCells,
  cells,
  readOnly,
}: {
  api: ApiClient;
  notebookId: string;
  doc: Y.Doc;
  cell: CellView;
  index: number;
  count: number;
  readOnly: boolean;
  runs: ReturnType<typeof useRuns>["runs"];
  loadFailures: ReturnType<typeof useRuns>["loadFailures"];
  cellStates: ReturnType<typeof useRuns>["cellStates"];
  ensureRun: (runId: string) => void;
  runCell: ReturnType<typeof useRuns>["runCell"];
  sqlCells: SqlCellOption[];
  cells: CellView[];
}) {
  const ownState = cellStates.get(cell.id) ?? { status: "idle" as const };
  const sharedRunActive = useRunActive(cell.running);
  // Our own request shows first; otherwise a run anyone started (from the
  // shared document) shows as running for everyone.
  const state: RunState =
    ownState.status === "idle" && sharedRunActive && cell.running
      ? { status: "running", by: cell.running.by }
      : ownState;
  const run = useCallback(async () => {
    const sql = cell.source?.toString().trim();
    if (!sql) return;
    // runCell ignores a submit while this cell is already running, so only
    // one run per cell can be in flight from this tab. The pointer it showed
    // now is compared when the response arrives, so a slow response can't
    // replace a newer result someone else produced meanwhile.
    const before = cell.lastRunId;
    const stored = await runCell(cell.id, sql);
    if (stored) setLastRunIfUnchanged(doc, cell.id, before, stored.id);
  }, [cell, doc, runCell]);
  // "Fix with AI" is offered when the cell's latest result is an error.
  const latest = cell.lastRunId ? runs.get(cell.lastRunId) : undefined;
  const failedRun: FailedRun | null =
    latest?.status === "error" ? { sql: latest.sql, error: latest.error.message } : null;

  return (
    <CellFrame
      cell={cell}
      index={index}
      count={count}
      onMove={(direction) => moveCell(doc, cell.id, direction)}
      onDelete={() => deleteCell(doc, cell.id)}
      readOnly={readOnly}
      actions={
        cell.type === "sql" && !readOnly ? (
          <RunButton state={state} onRun={() => void run()} />
        ) : null
      }
    >
      {cell.type === "sql" && cell.source && (
        <SqlCellBody
          cell={cell}
          source={cell.source}
          state={state}
          runs={runs}
          loadFailures={loadFailures}
          ensureRun={ensureRun}
          onRun={() => void run()}
          readOnly={readOnly}
          assistant={
            <AiAssist
              api={api}
              notebookId={notebookId}
              doc={doc}
              cellId={cell.id}
              source={cell.source}
              ai={cell.ai}
              failedRun={failedRun}
              readOnly={readOnly}
            />
          }
        />
      )}
      {cell.type === "markdown" && cell.source && (
        <MarkdownCellBody source={cell.source} readOnly={readOnly} />
      )}
      {cell.type === "chart" && cell.chart && (
        <ChartCell
          doc={doc}
          cell={cell}
          config={cell.chart}
          sqlCells={sqlCells}
          cells={cells}
          runs={runs}
          loadFailures={loadFailures}
          ensureRun={ensureRun}
          readOnly={readOnly}
        />
      )}
    </CellFrame>
  );
}

/**
 * Whether a cell's shared run is still in progress, re-rendering when its
 * lock expires. (If the API process running it died, nobody reports it
 * finished; past its lock's expiry it can't be running anymore.)
 */
function useRunActive(running: CellView["running"]): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running?.expiresAt) return;
    const remaining = Date.parse(running.expiresAt) - Date.now();
    if (Number.isNaN(remaining)) return;
    // Also fires at once for an already-expired run, refreshing `now`.
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, remaining) + 50);
    return () => clearTimeout(timer);
  }, [running]);
  return isRunActive(running, now);
}

/** A chart cell: its config form, drawn from the source SQL cell's latest result. */
function ChartCell({
  doc,
  cell,
  config,
  sqlCells,
  cells,
  runs,
  loadFailures,
  ensureRun,
  readOnly,
}: {
  doc: Y.Doc;
  cell: CellView;
  config: ChartConfig;
  sqlCells: SqlCellOption[];
  cells: CellView[];
  runs: ReturnType<typeof useRuns>["runs"];
  loadFailures: ReturnType<typeof useRuns>["loadFailures"];
  ensureRun: (runId: string) => void;
  readOnly: boolean;
}) {
  const sourceCell = cells.find((c) => c.id === config.source && c.type === "sql");
  const lastRunId = sourceCell?.lastRunId ?? null;
  useEffect(() => {
    if (lastRunId && !runs.has(lastRunId)) ensureRun(lastRunId);
  }, [lastRunId, runs, ensureRun]);
  const run = lastRunId ? runs.get(lastRunId) : undefined;

  let source: ChartSource;
  if (!config.source) source = { kind: "unset" };
  else if (!sourceCell) source = { kind: "deleted" };
  else if (!lastRunId) source = { kind: "not-run" };
  else if (run?.status === "ok") source = { kind: "ready", result: run.result };
  else if (run?.status === "error") source = { kind: "failed", message: run.error.message };
  // A pruned or deleted run (404) is gone; any other failure was transient
  // and the run is still stored.
  else if (loadFailures.get(lastRunId) === "missing") source = { kind: "unavailable" };
  else if (loadFailures.get(lastRunId) === "error") source = { kind: "load-error" };
  else source = { kind: "loading" };

  return (
    <ChartCellBody
      config={config}
      sqlCells={sqlCells}
      source={source}
      disabled={readOnly}
      onChange={(patch) => {
        const map = chartMap(doc, cell.id);
        if (map) writeChartConfig(map, patch);
      }}
    />
  );
}

function TitleEditor({ api, notebook }: { api: ApiClient; notebook: Notebook }) {
  const [title, setTitle] = useState(notebook.title);
  const [savedTitle, setSavedTitle] = useState(notebook.title);
  const [error, setError] = useState<string | null>(null);
  // Only the latest rename's response may update the saved title.
  const latestRename = useRef(0);

  const rename = async (next: string) => {
    const trimmed = next.trim();
    if (!trimmed || trimmed === savedTitle) {
      setTitle(savedTitle);
      return;
    }
    const seq = ++latestRename.current;
    try {
      const updated = await api.renameNotebook(notebook.id, trimmed);
      if (seq !== latestRename.current) return;
      setSavedTitle(updated.title);
      setTitle(updated.title);
      setError(null);
    } catch (e) {
      if (seq !== latestRename.current) return;
      setTitle(savedTitle);
      setError(e instanceof ApiError ? e.message : "Could not rename.");
    }
  };

  return (
    <>
      <input
        aria-label="Notebook title"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={(e) => void rename(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setTitle(savedTitle);
            // Blur after the revert renders, so blur sees the saved title.
            const input = e.currentTarget;
            requestAnimationFrame(() => input.blur());
          }
        }}
        className="w-full bg-transparent text-2xl font-semibold tracking-tight outline-none"
      />
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </>
  );
}

function AddCellButtons({ onAdd }: { onAdd: (type: CellType) => void }) {
  const labels: Record<CellType, string> = { sql: "SQL", markdown: "Markdown", chart: "Chart" };
  return (
    <div className="flex gap-2">
      {(Object.keys(labels) as CellType[]).map((type) => (
        <button
          key={type}
          onClick={() => onAdd(type)}
          className="rounded-md border border-dashed border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          + {labels[type]}
        </button>
      ))}
    </div>
  );
}
