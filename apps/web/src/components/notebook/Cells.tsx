"use client";

import { useState, useSyncExternalStore } from "react";
import * as Y from "yjs";

import { CodeEditor } from "@/components/notebook/CodeEditor";
import { MarkdownPreview } from "@/components/notebook/MarkdownPreview";
import { ResultTable } from "@/components/notebook/ResultTable";
import { RunErrorPanel } from "@/components/notebook/RunErrorPanel";
import { useLatestRun, type RunLoadFailure, type RunState } from "@/components/notebook/useRuns";
import { dangerButton, iconButton, runButton, smallButton } from "@/components/ui";
import type { QueryResult, Run } from "@/lib/api";
import type { CellType, CellView } from "@/lib/notebook/doc";

/** What each kind of cell is called on screen. */
export const CELL_LABELS: Record<CellType, string> = {
  sql: "Query",
  markdown: "Text",
  chart: "Chart",
};

interface CellFrameProps {
  cell: CellView;
  index: number;
  count: number;
  onMove: (direction: "up" | "down") => void;
  onDelete: () => void;
  actions?: React.ReactNode;
  /** View only: no move or delete buttons. */
  readOnly?: boolean;
  children: React.ReactNode;
}

export function CellFrame({
  cell,
  index,
  count,
  onMove,
  onDelete,
  actions,
  readOnly = false,
  children,
}: CellFrameProps) {
  return (
    <section
      aria-label={`${CELL_LABELS[cell.type]} cell ${index + 1}`}
      data-cell-id={cell.id}
      className="group scroll-mt-24 space-y-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition-shadow focus-within:border-zinc-300 focus-within:shadow-md dark:border-zinc-800 dark:bg-zinc-950"
    >
      <header className="flex items-center gap-2">
        <span className="flex h-5 min-w-5 items-center justify-center rounded bg-zinc-100 px-1 text-[11px] font-medium text-zinc-600 tabular-nums dark:bg-zinc-800">
          {index + 1}
        </span>
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {CELL_LABELS[cell.type]}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {actions}
          {!readOnly && (
            <CellEditButtons index={index} count={count} onMove={onMove} onDelete={onDelete} />
          )}
        </div>
      </header>
      {children}
    </section>
  );
}

function CellEditButtons({
  index,
  count,
  onMove,
  onDelete,
}: Pick<CellFrameProps, "index" | "count" | "onMove" | "onDelete">) {
  // Deleting takes two clicks: Yjs undo only covers text, so a deleted cell
  // can't be undone.
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span
        className="flex items-center gap-1"
        role="group"
        aria-label="Confirm deleting this cell"
      >
        <span className="text-xs text-zinc-600 dark:text-zinc-400">
          Delete this cell for everyone?
        </span>
        <button className={dangerButton} onClick={onDelete} aria-label="Confirm delete cell">
          Delete
        </button>
        <button className={smallButton} onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </span>
    );
  }
  return (
    <>
      <button
        className={iconButton}
        onClick={() => onMove("up")}
        disabled={index === 0}
        aria-label="Move cell up"
        title="Move up"
      >
        <Arrow direction="up" />
      </button>
      <button
        className={iconButton}
        onClick={() => onMove("down")}
        disabled={index === count - 1}
        aria-label="Move cell down"
        title="Move down"
      >
        <Arrow direction="down" />
      </button>
      <button
        className={iconButton}
        onClick={() => setConfirming(true)}
        aria-label="Delete cell"
        title="Delete cell"
      >
        <TrashIcon />
      </button>
    </>
  );
}

function Arrow({ direction }: { direction: "up" | "down" }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`h-4 w-4 fill-none stroke-current stroke-[1.5] ${direction === "down" ? "rotate-180" : ""}`}
    >
      <path d="M8 13V3M4 7l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-4 w-4 fill-none stroke-current stroke-[1.5]"
    >
      <path
        d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The current text of a Y.Text, re-rendering when it changes. */
export function useText(text: Y.Text): string {
  return useSyncExternalStore(
    (onChange) => {
      text.observe(onChange);
      return () => text.unobserve(onChange);
    },
    () => text.toString(),
    () => text.toString(),
  );
}

interface SqlCellProps {
  cell: CellView;
  source: Y.Text;
  state: RunState;
  runs: Map<string, Run>;
  loadFailures: Map<string, RunLoadFailure>;
  ensureRun: (runId: string) => void;
  onRun: () => void;
  /** View only: the SQL can't be edited or run (Mod-Enter does nothing). */
  readOnly?: boolean;
  /** The plain-English question box, shown above the SQL. */
  askBar?: React.ReactNode;
  /** The AI assistant's activity and suggestions, shown between the question and the SQL. */
  assistant?: React.ReactNode;
  /** More actions next to Run (Explain this query). */
  toolbar?: React.ReactNode;
  /** The main action offered when the run failed (Fix with AI). */
  errorAction?: React.ReactNode;
  /** Draws the latest result as a chart in a new cell. */
  onMakeChart?: (result: QueryResult) => void;
  /** Names the CSV download. */
  downloadName?: string;
}

export function SqlCellBody({
  cell,
  source,
  state,
  runs,
  loadFailures,
  ensureRun,
  onRun,
  readOnly = false,
  askBar,
  assistant,
  toolbar,
  errorAction,
  onMakeChart,
  downloadName,
}: SqlCellProps) {
  const run = useLatestRun(cell.lastRunId, runs, ensureRun);
  const loadFailure = cell.lastRunId ? loadFailures.get(cell.lastRunId) : undefined;
  const text = useText(source);
  // The shown result came from different SQL than what's in the editor now
  // (edited since, or edited while a run was in flight).
  const stale = run !== null && run.sql.trim() !== text.trim();
  return (
    <>
      {askBar}
      {assistant}
      <div className="space-y-2">
        <div className="relative [&_.cm-content]:pr-12!">
          <CodeEditor
            text={source}
            language="sql"
            placeholderText="Or write SQL here, e.g. select * from trips limit 10"
            onSubmit={readOnly ? undefined : onRun}
            readOnly={readOnly}
          />
          {/* Names what the code box holds, for people who've never seen SQL. */}
          <span className="pointer-events-none absolute right-2 top-1.5 z-10 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-zinc-600 dark:bg-zinc-800">
            SQL
          </span>
        </div>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <RunButton state={state} onRun={onRun} disabled={!text.trim()} />
            {toolbar}
            <span className="ml-auto hidden text-xs text-zinc-500 sm:inline">
              <kbd className="font-sans">Ctrl</kbd>/<kbd className="font-sans">⌘</kbd> +{" "}
              <kbd className="font-sans">Enter</kbd> runs
            </span>
          </div>
        )}
      </div>
      {state.status === "running" && (
        <p
          className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400"
          role="status"
        >
          <span
            aria-hidden="true"
            className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
          />
          <span>
            {state.ignoredSubmit
              ? "Already running. Run again when it finishes to use your latest edits."
              : state.by
                ? `Running… (started by ${state.by})`
                : "Running…"}
          </span>
        </p>
      )}
      {stale && state.status !== "running" && (
        <p className="text-xs text-amber-700" data-testid="stale-result">
          This result is from an earlier version of the query.
          {readOnly ? "" : " Run the cell to update it."}
        </p>
      )}
      {state.status === "failed" && (
        <p role="alert" className="text-sm text-red-600">
          {state.message}
        </p>
      )}
      {!run && loadFailure === "error" && (
        <p className="text-xs text-amber-700">
          Couldn&apos;t load the last result.{" "}
          <button className="underline" onClick={() => cell.lastRunId && ensureRun(cell.lastRunId)}>
            Retry
          </button>
        </p>
      )}
      {!run && loadFailure === "missing" && (
        <p className="text-xs text-zinc-500">
          The last result is no longer stored.{readOnly ? "" : " Run the cell again."}
        </p>
      )}
      {run?.status === "ok" && (
        <ResultTable
          result={run.result}
          onMakeChart={onMakeChart && (() => onMakeChart(run.result))}
          downloadName={downloadName}
        />
      )}
      {run?.status === "error" && <RunErrorPanel error={run.error} action={errorAction} />}
    </>
  );
}

export function RunButton({
  state,
  onRun,
  disabled = false,
}: {
  state: RunState;
  onRun: () => void;
  disabled?: boolean;
}) {
  const running = state.status === "running";
  return (
    <button
      className={runButton}
      onClick={onRun}
      disabled={running || disabled}
      title={disabled ? "Write or ask for a query first" : "Run the query (Ctrl/⌘ + Enter)"}
    >
      {!running && (
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
          <path d="M4 2.5v11l9-5.5-9-5.5z" />
        </svg>
      )}
      {running ? "Running…" : "Run"}
    </button>
  );
}

/**
 * A text cell's editing state. The cell's header shows the Edit button and
 * the body shows the editor, so the notebook owns this state for both.
 * A new, empty cell starts in the editor.
 */
export function useMarkdownEditing(source: Y.Text | null) {
  return useState(() => source !== null && source.length === 0);
}

/** "Edit", in a text cell's header next to move and delete: always visible. */
export function EditTextButton({ onEdit }: { onEdit: () => void }) {
  return (
    <button className={smallButton} onClick={onEdit} title="Edit this text (or double-click it)">
      Edit
    </button>
  );
}

export function MarkdownCellBody({
  source,
  readOnly = false,
  editing: controlledEditing,
  onEditingChange,
}: {
  source: Y.Text;
  /** View only: always the rendered preview, never the editor. */
  readOnly?: boolean;
  /**
   * Whether the editor is open, when the notebook controls it (its header
   * holds the Edit button). Uncontrolled, the body shows its own Edit button.
   */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [ownEditing, setOwnEditing] = useState(source.length === 0);
  const controlled = controlledEditing !== undefined;
  const editing = controlled ? controlledEditing : ownEditing;
  const setEditing = (next: boolean) => {
    if (controlled) onEditingChange?.(next);
    else setOwnEditing(next);
  };
  const text = useText(source);
  if (readOnly) {
    return text.trim() ? (
      <MarkdownPreview source={text} />
    ) : (
      <p className="text-sm text-zinc-500">Empty text cell.</p>
    );
  }
  if (editing) {
    return (
      <div className="space-y-2">
        <CodeEditor
          text={source}
          language="markdown"
          placeholderText="Write notes here. # makes a heading, **bold**, - a list…"
          onSubmit={() => setEditing(false)}
        />
        <button className={smallButton} onClick={() => setEditing(false)}>
          Done
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {/* Double-click is a shortcut; the Edit button is the accessible way in. */}
      <div onDoubleClick={() => setEditing(true)} title="Double-click to edit">
        {text.trim() ? (
          <MarkdownPreview source={text} />
        ) : (
          <p className="text-sm text-zinc-500">Empty text cell.</p>
        )}
      </div>
      {!controlled && <EditTextButton onEdit={() => setEditing(true)} />}
    </div>
  );
}
