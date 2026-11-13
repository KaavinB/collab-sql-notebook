"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, type ApiClient, type Run } from "@/lib/api";

export type RunState =
  | { status: "idle" }
  /** `ignoredSubmit`: the user pressed Run again while this run was in flight. */
  | { status: "running"; ignoredSubmit?: boolean }
  | { status: "failed"; message: string };

/** Why a run the document points at couldn't be shown. */
export type RunLoadFailure = "missing" | "error";

/**
 * Stored runs for one notebook, by run ID, plus each cell's in-flight state.
 *
 * Results live in Postgres; the document only stores each cell's latest
 * run ID. When a cell points at a run this client hasn't seen (for example
 * after a reload), the run is fetched and cached.
 *
 * One run per cell at a time: while a cell's run is in flight, further
 * submits for that cell (Run button or Cmd/Ctrl+Enter) are ignored. Aborting
 * a request wouldn't free anything: the server keeps running the query and
 * holds a worker until it finishes. So replacing runs would let repeated
 * presses fill the worker pool, and a slow earlier run could finish after,
 * and overwrite, a newer one. (Phase 2's server-side execution lock makes
 * this hold across users too.)
 */
export function useRuns(api: ApiClient, notebookId: string) {
  const [runs, setRuns] = useState<Map<string, Run>>(new Map());
  const [loadFailures, setLoadFailures] = useState<Map<string, RunLoadFailure>>(new Map());
  const [cellStates, setCellStates] = useState<Map<string, RunState>>(new Map());
  const requested = useRef(new Set<string>());
  // A ref, not state: two key presses in the same frame must both see it.
  const inFlight = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const running = inFlight.current;
    // Leaving the page stops waiting for in-flight runs. (Each finishes on
    // the server anyway; that's at most one per cell.)
    return () => running.forEach((controller) => controller.abort());
  }, []);

  const setCellState = (cellId: string, state: RunState) =>
    setCellStates((prev) => new Map(prev).set(cellId, state));

  const ensureRun = useCallback(
    (runId: string) => {
      if (requested.current.has(runId)) return;
      requested.current.add(runId);
      setLoadFailures((prev) => {
        const next = new Map(prev);
        next.delete(runId);
        return next;
      });
      api.getRun(notebookId, runId).then(
        (run) => setRuns((prev) => new Map(prev).set(run.id, run)),
        (error: unknown) => {
          const missing = error instanceof ApiError && error.status === 404;
          // A transient failure can be retried; a pruned or deleted run can't.
          if (!missing) requested.current.delete(runId);
          setLoadFailures((prev) => new Map(prev).set(runId, missing ? "missing" : "error"));
        },
      );
    },
    [api, notebookId],
  );

  /**
   * Runs the SQL and returns the stored run. Returns null if it failed, or if
   * the cell already has a run in flight (the submit is ignored).
   */
  const runCell = useCallback(
    async (cellId: string, sql: string): Promise<Run | null> => {
      if (inFlight.current.has(cellId)) {
        // Say so, rather than dropping the submit silently.
        setCellState(cellId, { status: "running", ignoredSubmit: true });
        return null;
      }
      const controller = new AbortController();
      inFlight.current.set(cellId, controller);
      setCellState(cellId, { status: "running" });
      try {
        const run = await api.runCell(notebookId, cellId, sql, controller.signal);
        requested.current.add(run.id);
        setRuns((prev) => new Map(prev).set(run.id, run));
        setCellState(cellId, { status: "idle" });
        return run;
      } catch (error) {
        const message =
          error instanceof ApiError ? error.message : "Something went wrong running the query.";
        setCellState(cellId, { status: "failed", message });
        return null;
      } finally {
        inFlight.current.delete(cellId);
      }
    },
    [api, notebookId],
  );

  return { runs, loadFailures, cellStates, ensureRun, runCell };
}

/** The cell's latest run, fetching it when needed. */
export function useLatestRun(
  lastRunId: string | null,
  runs: Map<string, Run>,
  ensureRun: (runId: string) => void,
): Run | null {
  useEffect(() => {
    if (lastRunId && !runs.has(lastRunId)) ensureRun(lastRunId);
  }, [lastRunId, runs, ensureRun]);
  return lastRunId ? (runs.get(lastRunId) ?? null) : null;
}
