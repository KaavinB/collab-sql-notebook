"use client";

import { useState, useSyncExternalStore } from "react";
import * as Y from "yjs";

import { CodeEditor } from "@/components/notebook/CodeEditor";
import { MarkdownPreview } from "@/components/notebook/MarkdownPreview";
import { ResultTable } from "@/components/notebook/ResultTable";
import { useLatestRun, type RunLoadFailure, type RunState } from "@/components/notebook/useRuns";
import type { Run } from "@/lib/api";
import type { CellView } from "@/lib/notebook/doc";

const button =
  "rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800";

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
      aria-label={`${cell.type} cell ${index + 1}`}
      data-cell-id={cell.id}
      className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
    >
      <header className="flex items-center gap-2">
        <span className="font-mono text-xs uppercase text-zinc-500">{cell.type}</span>
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
  // can't be undone (a known Phase 1 limitation).
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button
        className={button}
        onClick={() => onMove("up")}
        disabled={index === 0}
        aria-label="Move cell up"
      >
        ↑
      </button>
      <button
        className={button}
        onClick={() => onMove("down")}
        disabled={index === count - 1}
        aria-label="Move cell down"
      >
        ↓
      </button>
      {confirming ? (
        <>
          <button
            className={`${button} border-red-500 text-red-600`}
            onClick={onDelete}
            aria-label="Confirm delete cell"
          >
            Confirm delete
          </button>
          <button className={button} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button className={button} onClick={() => setConfirming(true)} aria-label="Delete cell">
          Delete
        </button>
      )}
    </>
  );
}

/** The current text of a Y.Text, re-rendering when it changes. */
function useText(text: Y.Text): string {
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
}: SqlCellProps) {
  const run = useLatestRun(cell.lastRunId, runs, ensureRun);
  const loadFailure = cell.lastRunId ? loadFailures.get(cell.lastRunId) : undefined;
  const text = useText(source);
  // The shown result came from different SQL than what's in the editor now
  // (edited since, or edited while a run was in flight).
  const stale = run !== null && run.sql.trim() !== text.trim();
  return (
    <>
      <CodeEditor
        text={source}
        language="sql"
        placeholderText="select * from trips limit 10"
        onSubmit={readOnly ? undefined : onRun}
        readOnly={readOnly}
      />
      {state.status === "running" && (
        <p className="text-xs text-zinc-500" role="status">
          {state.ignoredSubmit
            ? "Already running. Run again when it finishes to use your latest edits."
            : state.by
              ? `Running… (started by ${state.by})`
              : "Running…"}
        </p>
      )}
      {stale && state.status !== "running" && (
        <p className="text-xs text-amber-700" data-testid="stale-result">
          This result is from an earlier version of the query.
          {readOnly ? "" : " Run the cell to update it."}
        </p>
      )}
      {state.status === "failed" && (
        <p role="alert" className="text-xs text-red-600">
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
      {run?.status === "ok" && <ResultTable result={run.result} />}
      {run?.status === "error" && (
        <pre
          role="alert"
          className="whitespace-pre-wrap rounded-md bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300"
        >
          {run.error.kind === "rejected" ? "Not allowed: " : ""}
          {run.error.message}
        </pre>
      )}
    </>
  );
}

export function RunButton({ state, onRun }: { state: RunState; onRun: () => void }) {
  return (
    <button
      className={`${button} border-emerald-600 text-emerald-700 dark:text-emerald-400`}
      onClick={onRun}
      disabled={state.status === "running"}
      title="Run (Cmd/Ctrl+Enter)"
    >
      {state.status === "running" ? "Running…" : "Run"}
    </button>
  );
}

export function MarkdownCellBody({
  source,
  readOnly = false,
}: {
  source: Y.Text;
  /** View only: always the rendered preview, never the editor. */
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(source.length === 0);
  const text = useText(source);
  if (readOnly) {
    return text.trim() ? (
      <MarkdownPreview source={text} />
    ) : (
      <p className="text-sm text-zinc-500">Empty markdown cell.</p>
    );
  }
  if (editing) {
    return (
      <div className="space-y-1">
        <CodeEditor
          text={source}
          language="markdown"
          placeholderText="Write markdown…"
          onSubmit={() => setEditing(false)}
        />
        <button className={button} onClick={() => setEditing(false)}>
          Done
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {/* Double-click is a shortcut; the Edit button is the accessible way in. */}
      <div onDoubleClick={() => setEditing(true)} title="Double-click to edit">
        <MarkdownPreview source={text} />
      </div>
      <button className={button} onClick={() => setEditing(true)}>
        Edit
      </button>
    </div>
  );
}
