"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";

import { CellFrame, MarkdownCellBody, RunButton, SqlCellBody } from "@/components/notebook/Cells";
import {
  ChartCellBody,
  type ChartSource,
  type SqlCellOption,
} from "@/components/notebook/ChartCell";
import { useRuns } from "@/components/notebook/useRuns";
import { SharePanel } from "@/components/sharing/SharePanel";
import { ApiError, createApiClient, type ApiClient, type Notebook } from "@/lib/api";
import { attachAutosave, LOAD_ORIGIN, type Autosave } from "@/lib/notebook/autosave";
import { writeChartConfig, type ChartConfig } from "@/lib/notebook/chart";
import {
  appendCell,
  chartMap,
  deleteCell,
  moveCell,
  setLastRun,
  type CellType,
  type CellView,
} from "@/lib/notebook/doc";
import {
  createSaveStateStore,
  isPermanentSaveError,
  saveLabel,
  type SaveStateStore,
} from "@/lib/notebook/saveStatus";
import { useCells } from "@/lib/notebook/useCells";
import { trackPendingWork } from "@/lib/pendingWork";

type Loaded = { doc: Y.Doc; notebook: Notebook };

/**
 * Saves still finishing after their page unmounted, by notebook ID. Reopening
 * the notebook waits for them before loading, so it can't load an older
 * snapshot and then autosave it over the edits that were still in flight.
 */
const pendingFlushes = new Map<string, Promise<void>>();

export function NotebookEditor({
  notebookId,
  api: injected,
}: {
  notebookId: string;
  api?: ApiClient;
}) {
  const api = useMemo(() => injected ?? createApiClient(), [injected]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const saveState = useMemo(() => createSaveStateStore(), []);

  // Load the notebook, apply its snapshot, and only then start autosaving,
  // so an early save can never overwrite the stored document with an empty one.
  useEffect(() => {
    let cancelled = false;
    const doc = new Y.Doc();
    let autosave: Autosave | null = null;
    (async () => {
      try {
        await pendingFlushes.get(notebookId);
        const [notebook, snapshot] = await Promise.all([
          api.getNotebook(notebookId),
          api.loadSnapshot(notebookId),
        ]);
        if (cancelled) return;
        if (snapshot) Y.applyUpdate(doc, snapshot, LOAD_ORIGIN);
        autosave = attachAutosave(doc, {
          save: (state) => api.saveSnapshot(notebookId, state),
          onStatus: (status, error) =>
            saveState.set(
              status === "error"
                ? { status, error, permanent: isPermanentSaveError(error) }
                : { status },
            ),
          isPermanentError: isPermanentSaveError,
        });
        setLoaded({ doc, notebook });
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof ApiError ? error.message : "Could not load the notebook.");
        }
      }
    })();
    return () => {
      cancelled = true;
      const pending = autosave;
      if (!pending) {
        doc.destroy();
        return;
      }
      // Save what's pending before letting go of the document.
      const flushed: Promise<void> = pending
        .flush()
        .catch(() => {})
        .finally(() => {
          pending.dispose();
          doc.destroy();
          if (pendingFlushes.get(notebookId) === flushed) pendingFlushes.delete(notebookId);
        });
      pendingFlushes.set(notebookId, flushed);
      // Signing out waits for this save before ending the session.
      trackPendingWork(flushed);
    };
  }, [api, notebookId, saveState]);

  // Warn before closing the tab with unsaved changes.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (saveState.get().status !== "saved") event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);

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
  if (!loaded) return <p className="text-zinc-500">Loading notebook…</p>;
  return <LoadedNotebook api={api} loaded={loaded} saveState={saveState} />;
}

/** The save status, re-rendering only itself when it changes. */
function SaveStatusLabel({ store }: { store: SaveStateStore }) {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const failed = state.status === "error";
  return (
    <span
      className={`ml-auto text-xs ${failed ? "text-red-600" : "text-zinc-500"}`}
      role={failed && state.permanent ? "alert" : "status"}
      data-testid="save-status"
    >
      {saveLabel(state)}
    </span>
  );
}

function LoadedNotebook({
  api,
  loaded,
  saveState,
}: {
  api: ApiClient;
  loaded: Loaded;
  saveState: SaveStateStore;
}) {
  const { doc, notebook } = loaded;
  // Viewers read; the API refuses their writes anyway, and the sync server
  // drops their document updates. The UI just doesn't offer them.
  const readOnly = notebook.role === "viewer";
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
        <SaveStatusLabel store={saveState} />
      </div>
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
  const state = cellStates.get(cell.id) ?? { status: "idle" as const };
  const run = useCallback(async () => {
    const sql = cell.source?.toString().trim();
    if (!sql) return;
    // runCell ignores a submit while this cell is already running, so only
    // one run per cell can be in flight and re-point the cell.
    const stored = await runCell(cell.id, sql);
    if (stored) setLastRun(doc, cell.id, stored.id);
  }, [cell, doc, runCell]);

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
