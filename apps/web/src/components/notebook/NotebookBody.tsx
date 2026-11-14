"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";

import {
  AiActivity,
  AiAskBar,
  AiExplainButton,
  AiFixButton,
  SparkIcon,
  useAiAssistant,
  type FailedRun,
} from "@/components/notebook/AiAssist";
import {
  CellFrame,
  EditTextButton,
  MarkdownCellBody,
  SqlCellBody,
  useMarkdownEditing,
} from "@/components/notebook/Cells";
import {
  ChartCellBody,
  type ChartSource,
  type SqlCellOption,
} from "@/components/notebook/ChartCell";
import { DataGuide } from "@/components/notebook/DataGuide";
import { EmptyNotebook } from "@/components/notebook/EmptyNotebook";
import { ShortcutsHelp } from "@/components/notebook/ShortcutsHelp";
import { useRuns, type RunState } from "@/components/notebook/useRuns";
import { SharePanel } from "@/components/sharing/SharePanel";
import { aiButton, link, secondaryButton, smallButton } from "@/components/ui";
import { ApiError, type ApiClient, type Notebook, type QueryResult } from "@/lib/api";
import { pickChartConfig } from "@/lib/notebook/autoChart";
import { writeChartConfig, type ChartConfig } from "@/lib/notebook/chart";
import {
  appendCell,
  chartMap,
  deleteCell,
  insertCell,
  isRunActive,
  moveCell,
  orderedCells,
  setLastRunIfUnchanged,
  type CellType,
  type CellView,
} from "@/lib/notebook/doc";
import { seedExample, takeExampleMark } from "@/lib/notebook/example";
import { queueQuestion } from "@/lib/notebook/pendingQuestions";
import { useCells } from "@/lib/notebook/useCells";

type RunCell = ReturnType<typeof useRuns>["runCell"];

/**
 * Runs a sql cell's current text and points the cell at the stored run.
 * runCell ignores a submit while the cell is already running, so only one
 * run per cell can be in flight from this tab. The pointer shown when Run was
 * pressed is compared when the response arrives, so a slow response can't
 * replace a newer result someone else produced meanwhile.
 */
async function runSqlCell(doc: Y.Doc, cellId: string, runCell: RunCell): Promise<void> {
  const cell = orderedCells(doc).find((c) => c.id === cellId);
  const sql = cell?.source?.toString().trim();
  if (!cell || !sql) return;
  const before = cell.lastRunId;
  const stored = await runCell(cell.id, sql);
  if (stored) setLastRunIfUnchanged(doc, cell.id, before, stored.id);
}

/** Where to take the person after adding a cell: its question box or its editor. */
type FocusTarget = { cellId: string; on: "ask" | "editor" | "cell" };

/**
 * The notebook itself, once its document is live: header, cells and the
 * ways to add more.
 */
export function LoadedNotebook({
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
  const [guideOpen, setGuideOpen] = useState(false);
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  // SQL cells a chart can draw from, labeled by their position. (Not by their
  // text: this list only updates on structural changes, not while typing.)
  const sqlCells = useMemo(
    () =>
      cells.flatMap((cell, index) =>
        cell.type === "sql" ? [{ id: cell.id, label: `Query in cell ${index + 1}` }] : [],
      ),
    [cells],
  );

  // A new cell scrolls into view and takes the keyboard, so adding one always
  // visibly does something.
  useEffect(() => {
    if (!focus) return;
    const section = document.querySelector<HTMLElement>(`[data-cell-id="${focus.cellId}"]`);
    if (!section) return;
    section.scrollIntoView?.({ block: "center", behavior: "smooth" });
    const target =
      focus.on === "ask"
        ? section.querySelector<HTMLElement>("[data-ask-input]")
        : focus.on === "editor"
          ? section.querySelector<HTMLElement>(".cm-content")
          : null;
    target?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot request, consumed
    setFocus(null);
  }, [focus, cells]);

  const add = (type: CellType, on: FocusTarget["on"]) => {
    const id = appendCell(doc, type);
    setFocus({ cellId: id, on });
  };
  const ask = (question: string) => {
    const id = appendCell(doc, "sql");
    queueQuestion(id, question);
    setFocus({ cellId: id, on: "cell" });
    setGuideOpen(false);
  };
  const makeChart = (sourceId: string, result: QueryResult) => {
    let id = "";
    // One transaction: collaborators see the chart arrive already set up,
    // never an empty chart cell first.
    doc.transact(() => {
      id = insertCell(doc, "chart", sourceId);
      const map = chartMap(doc, id);
      try {
        if (map) writeChartConfig(map, pickChartConfig(result, sourceId));
      } catch {
        // A column name too long to store: the chart cell stays, with its
        // controls to pick columns by hand.
      }
    });
    setFocus({ cellId: id, on: "cell" });
  };

  useExampleTour(doc, notebook.id, readOnly, runCell);

  return (
    <div className="space-y-5">
      <div className="sticky top-0 z-30 -mx-6 flex flex-wrap items-center gap-2 border-b border-zinc-200/80 bg-zinc-50/90 px-6 py-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
        <Link href="/" className={link}>
          ← Notebooks
        </Link>
        {readOnly && (
          <span
            className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            data-testid="view-only"
          >
            View only
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {presence}
          <StatusPill>{status}</StatusPill>
          <button
            className={secondaryButton}
            onClick={() => setGuideOpen(true)}
            aria-haspopup="dialog"
            title="What's in the taxi data, with example questions"
          >
            About the data
          </button>
          <ShortcutsHelp />
          <SharePanel api={api} notebook={notebook} />
        </div>
      </div>

      {readOnly ? (
        <h1 className="text-3xl font-semibold tracking-tight">{notebook.title}</h1>
      ) : (
        <TitleEditor api={api} notebook={notebook} />
      )}
      {notebook.role === "viewer" && (
        <p
          className="rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          data-testid="viewer-note"
        >
          You can view this notebook and see changes live, but not edit it or run queries. Ask the
          owner for an edit link if you need to.
        </p>
      )}

      {cells.length === 0 &&
        (readOnly ? (
          <p className="text-sm text-zinc-500">This notebook is empty.</p>
        ) : (
          <EmptyNotebook onAsk={ask} onOpenGuide={() => setGuideOpen(true)} />
        ))}
      {cells.map((cell, index) => (
        <Cell
          key={cell.id}
          api={api}
          notebook={notebook}
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
          onMakeChart={makeChart}
        />
      ))}

      {!readOnly && <AddCellBar onAdd={add} />}
      {guideOpen && (
        <DataGuide onClose={() => setGuideOpen(false)} onAsk={readOnly ? undefined : ask} />
      )}
    </div>
  );
}

/**
 * Fills a notebook created with "Start with an example" with the guided
 * tour, then runs its query so the result and chart are there to look at.
 * The runs wait for a timer that's cancelled on cleanup, so React's
 * development double-mount doesn't start them twice or abort them.
 */
function useExampleTour(doc: Y.Doc, notebookId: string, readOnly: boolean, runCell: RunCell) {
  const toRun = useRef<string[] | null>(null);
  useEffect(() => {
    if (readOnly) return;
    if (toRun.current === null) {
      toRun.current = takeExampleMark(notebookId) ? seedExample(doc) : [];
    }
    if (toRun.current.length === 0) return;
    const timer = setTimeout(() => {
      const ids = toRun.current ?? [];
      toRun.current = [];
      for (const id of ids) void runSqlCell(doc, id, runCell);
    }, 0);
    return () => clearTimeout(timer);
  }, [doc, notebookId, readOnly, runCell]);
}

function Cell({
  api,
  notebook,
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
  onMakeChart,
}: {
  api: ApiClient;
  notebook: Notebook;
  doc: Y.Doc;
  cell: CellView;
  index: number;
  count: number;
  readOnly: boolean;
  runs: ReturnType<typeof useRuns>["runs"];
  loadFailures: ReturnType<typeof useRuns>["loadFailures"];
  cellStates: ReturnType<typeof useRuns>["cellStates"];
  ensureRun: (runId: string) => void;
  runCell: RunCell;
  sqlCells: SqlCellOption[];
  cells: CellView[];
  onMakeChart: (sourceId: string, result: QueryResult) => void;
}) {
  const [editingText, setEditingText] = useMarkdownEditing(
    cell.type === "markdown" ? cell.source : null,
  );
  return (
    <CellFrame
      cell={cell}
      index={index}
      count={count}
      onMove={(direction) => moveCell(doc, cell.id, direction)}
      onDelete={() => deleteCell(doc, cell.id)}
      readOnly={readOnly}
      actions={
        cell.type === "markdown" && !readOnly && !editingText ? (
          <EditTextButton onEdit={() => setEditingText(true)} />
        ) : null
      }
    >
      {cell.type === "sql" && cell.source && (
        <SqlCell
          api={api}
          notebook={notebook}
          doc={doc}
          cell={cell}
          source={cell.source}
          index={index}
          runs={runs}
          loadFailures={loadFailures}
          cellStates={cellStates}
          ensureRun={ensureRun}
          runCell={runCell}
          readOnly={readOnly}
          onMakeChart={onMakeChart}
        />
      )}
      {cell.type === "markdown" && cell.source && (
        <MarkdownCellBody
          source={cell.source}
          readOnly={readOnly}
          editing={editingText}
          onEditingChange={setEditingText}
        />
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

/** A query cell: the question box and AI, the SQL, and its result. */
function SqlCell({
  api,
  notebook,
  doc,
  cell,
  source,
  index,
  runs,
  loadFailures,
  cellStates,
  ensureRun,
  runCell,
  readOnly,
  onMakeChart,
}: {
  api: ApiClient;
  notebook: Notebook;
  doc: Y.Doc;
  cell: CellView;
  source: Y.Text;
  index: number;
  readOnly: boolean;
  runs: ReturnType<typeof useRuns>["runs"];
  loadFailures: ReturnType<typeof useRuns>["loadFailures"];
  cellStates: ReturnType<typeof useRuns>["cellStates"];
  ensureRun: (runId: string) => void;
  runCell: RunCell;
  onMakeChart: (sourceId: string, result: QueryResult) => void;
}) {
  const ownState = cellStates.get(cell.id) ?? { status: "idle" as const };
  const sharedRunActive = useRunActive(cell.running);
  // Our own request shows first; otherwise a run anyone started (from the
  // shared document) shows as running for everyone.
  const state: RunState =
    ownState.status === "idle" && sharedRunActive && cell.running
      ? { status: "running", by: cell.running.by }
      : ownState;
  const run = useCallback(() => void runSqlCell(doc, cell.id, runCell), [doc, cell.id, runCell]);
  // "Fix with AI" is offered when the cell's latest result is an error.
  const latest = cell.lastRunId ? runs.get(cell.lastRunId) : undefined;
  const failedRun: FailedRun | null =
    latest?.status === "error" ? { sql: latest.sql, error: latest.error.message } : null;
  const assistant = useAiAssistant({
    api,
    notebookId: notebook.id,
    doc,
    cellId: cell.id,
    source,
    ai: cell.ai,
    failedRun,
    readOnly,
  });
  return (
    <SqlCellBody
      cell={cell}
      source={source}
      state={state}
      runs={runs}
      loadFailures={loadFailures}
      ensureRun={ensureRun}
      onRun={run}
      readOnly={readOnly}
      askBar={<AiAskBar assistant={assistant} large={!assistant.text.trim()} />}
      assistant={<AiActivity assistant={assistant} onRun={run} />}
      toolbar={<AiExplainButton assistant={assistant} label="Explain this query" />}
      errorAction={<AiFixButton assistant={assistant} primary />}
      onMakeChart={readOnly ? undefined : (result) => onMakeChart(cell.id, result)}
      downloadName={`${notebook.title} cell ${index + 1}`}
    />
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
  const [saved, setSaved] = useState(false);
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
      setSaved(true);
    } catch (e) {
      if (seq !== latestRename.current) return;
      setTitle(savedTitle);
      setError(e instanceof ApiError ? e.message : "Could not rename.");
    }
  };

  return (
    <div>
      <input
        aria-label="Notebook title"
        title="Click to rename"
        value={title}
        maxLength={200}
        onChange={(e) => {
          setTitle(e.target.value);
          setSaved(false);
        }}
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
        className="-mx-2 w-full rounded-md bg-transparent px-2 py-1 text-3xl font-semibold tracking-tight outline-none hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-zinc-900 dark:focus-visible:bg-zinc-900"
      />
      {saved && (
        <p role="status" className="text-xs text-zinc-500">
          Renamed.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The live-sync status, in a pill in the header. The status text comes from
 * the sync code and can be a whole sentence ("Offline. Unsynced edits will
 * sync when you reconnect."), so the pill shows the start of it on one line
 * (the first word says the state) and the full sentence in its tooltip. Only
 * when live does the tooltip explain that there's no Save button: while
 * offline or unsynced, changes aren't shared yet.
 */
function StatusPill({ children }: { children: React.ReactNode }) {
  const pill = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = pill.current;
    if (!node) return;
    const text = node.textContent?.trim() ?? "";
    node.title =
      text === "Live"
        ? "Live: changes are shared with everyone as they happen. There's no Save button."
        : text;
  });
  return (
    <span
      ref={pill}
      className="flex min-w-0 max-w-56 items-center overflow-hidden rounded-full border border-zinc-200 px-2.5 py-1 dark:border-zinc-800 [&>*]:block [&>*]:truncate"
    >
      {children}
    </span>
  );
}

/** Adding cells: asking a question first, then the hands-on cell types. */
function AddCellBar({ onAdd }: { onAdd: (type: CellType, on: FocusTarget["on"]) => void }) {
  const kinds: { type: CellType; label: string; title: string; on: FocusTarget["on"] }[] = [
    { type: "sql", label: "+ Query", title: "A query cell, to write SQL yourself", on: "editor" },
    {
      type: "markdown",
      label: "+ Text",
      title: "A text cell for notes and headings",
      on: "editor",
    },
    { type: "chart", label: "+ Chart", title: "A chart drawn from a query's result", on: "cell" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
      <button
        className={aiButton}
        onClick={() => onAdd("sql", "ask")}
        title="Add a query cell and ask the AI in plain English"
      >
        <SparkIcon />
        Ask a question
      </button>
      <span className="px-1 text-xs text-zinc-500">or add</span>
      {kinds.map(({ type, label, title, on }) => (
        <button key={type} onClick={() => onAdd(type, on)} className={smallButton} title={title}>
          {label}
        </button>
      ))}
    </div>
  );
}
