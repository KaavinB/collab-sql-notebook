// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useRuns } from "@/components/notebook/useRuns";
import { ApiError, type ApiClient, type Run } from "@/lib/api";
import { deferred, fakeApi, NOTEBOOK, okRun } from "@/test/fakeApi";

describe("useRuns", () => {
  it("ignores further submits for a cell while its run is in flight", async () => {
    const first = deferred<Run>();
    const runCell = vi.fn<ApiClient["runCell"]>(() => first.promise);
    const api = fakeApi({ runCell });
    const { result } = renderHook(() => useRuns(api, NOTEBOOK.id));

    let running!: Promise<Run | null>;
    let ignored: (Run | null)[] = [];
    act(() => {
      running = result.current.runCell("c1", "select slow");
    });
    // Two quick key presses in the same frame, then another after a render.
    await act(async () => {
      ignored = await Promise.all([
        result.current.runCell("c1", "select 2"),
        result.current.runCell("c1", "select 3"),
      ]);
    });
    expect(ignored).toEqual([null, null]);
    expect(runCell).toHaveBeenCalledTimes(1); // the server got exactly one query

    await act(async () => first.resolve(okRun("r1", "slow")));
    expect(await running).toMatchObject({ id: "r1" });
    expect(result.current.cellStates.get("c1")).toEqual({ status: "idle" });

    // Once it's done, the cell can run again.
    runCell.mockResolvedValueOnce(okRun("r2", 2));
    let again: Run | null = null;
    await act(async () => {
      again = await result.current.runCell("c1", "select 2");
    });
    expect(again).toMatchObject({ id: "r2" });
    expect(runCell).toHaveBeenCalledTimes(2);
  });

  it("flags an ignored submit, and clears the flag when the run settles", async () => {
    const first = deferred<Run>();
    const api = fakeApi({ runCell: vi.fn<ApiClient["runCell"]>(() => first.promise) });
    const { result } = renderHook(() => useRuns(api, NOTEBOOK.id));
    act(() => void result.current.runCell("c1", "select 1"));
    expect(result.current.cellStates.get("c1")).toEqual({ status: "running" });
    await act(async () => {
      expect(await result.current.runCell("c1", "select 2")).toBeNull();
    });
    expect(result.current.cellStates.get("c1")).toEqual({ status: "running", ignoredSubmit: true });
    await act(async () => first.resolve(okRun("r1", 1)));
    expect(result.current.cellStates.get("c1")).toEqual({ status: "idle" });
  });

  it("allows running again after a failed run", async () => {
    const runCell = vi
      .fn<ApiClient["runCell"]>()
      .mockRejectedValueOnce(new ApiError(503, "busy", "busy"))
      .mockResolvedValueOnce(okRun("r2", 2));
    const { result } = renderHook(() => useRuns(fakeApi({ runCell }), NOTEBOOK.id));
    await act(async () => {
      await result.current.runCell("c1", "select 1");
    });
    let second: Run | null = null;
    await act(async () => {
      second = await result.current.runCell("c1", "select 1");
    });
    expect(second).toMatchObject({ id: "r2" });
  });

  it("stops waiting for in-flight runs when the page goes away", () => {
    const signals: AbortSignal[] = [];
    const api = fakeApi({
      runCell: (_nb, _cell, _sql, signal) => {
        signals.push(signal!);
        return new Promise<Run>(() => {});
      },
    });
    const { result, unmount } = renderHook(() => useRuns(api, NOTEBOOK.id));
    act(() => void result.current.runCell("c1", "select 1"));
    unmount();
    expect(signals[0].aborted).toBe(true);
  });

  it("runs in different cells don't interfere", async () => {
    const api = fakeApi({ runCell: async (_nb, cell) => okRun(`run-${cell}`, cell, cell) });
    const { result } = renderHook(() => useRuns(api, NOTEBOOK.id));
    let runs: (Run | null)[] = [];
    await act(async () => {
      runs = await Promise.all([
        result.current.runCell("a", "x"),
        result.current.runCell("b", "y"),
      ]);
    });
    expect(runs.map((r) => r?.id)).toEqual(["run-a", "run-b"]);
  });

  it("shows a failed run's message", async () => {
    const api = fakeApi({
      runCell: async () => {
        throw new ApiError(503, "busy", "All query workers are busy.");
      },
    });
    const { result } = renderHook(() => useRuns(api, NOTEBOOK.id));
    await act(async () => {
      await result.current.runCell("c1", "select 1");
    });
    expect(result.current.cellStates.get("c1")).toEqual({
      status: "failed",
      message: "All query workers are busy.",
    });
  });

  it("fetches a run once, and marks a pruned run as missing without retrying", async () => {
    const api = fakeApi({
      getRun: async () => {
        throw new ApiError(404, "not_found", "Run not found.");
      },
    });
    const getRun = vi.spyOn(api, "getRun");
    const { result } = renderHook(() => useRuns(api, NOTEBOOK.id));
    act(() => result.current.ensureRun("gone"));
    await waitFor(() => expect(result.current.loadFailures.get("gone")).toBe("missing"));
    act(() => result.current.ensureRun("gone"));
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  it("allows retrying a run that failed to load for a transient reason", async () => {
    let attempts = 0;
    const api = fakeApi({
      getRun: async (_nb, id) => {
        attempts++;
        if (attempts === 1) throw new ApiError(0, "network", "Could not reach the server.");
        return okRun(id, 1);
      },
    });
    const { result } = renderHook(() => useRuns(api, NOTEBOOK.id));
    act(() => result.current.ensureRun("r1"));
    await waitFor(() => expect(result.current.loadFailures.get("r1")).toBe("error"));
    act(() => result.current.ensureRun("r1"));
    await waitFor(() => expect(result.current.runs.has("r1")).toBe(true));
    expect(result.current.loadFailures.has("r1")).toBe(false);
  });
});
