// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { appendCell, moveCell, orderedCells, setLastRun } from "@/lib/notebook/doc";
import { useCells } from "@/lib/notebook/useCells";

function setup() {
  const doc = new Y.Doc();
  appendCell(doc, "sql", "a");
  appendCell(doc, "sql", "b");
  let renders = 0;
  const hook = renderHook(() => {
    renders++;
    return useCells(doc);
  });
  return { doc, hook, renders: () => renders };
}

describe("useCells", () => {
  it("re-renders when cells are added, moved or re-pointed at a run", () => {
    const { doc, hook } = setup();
    expect(hook.result.current.map((c) => c.id)).toEqual(["a", "b"]);
    act(() => void appendCell(doc, "markdown", "c"));
    expect(hook.result.current.map((c) => c.id)).toEqual(["a", "b", "c"]);
    act(() => void moveCell(doc, "c", "up"));
    expect(hook.result.current.map((c) => c.id)).toEqual(["a", "c", "b"]);
    act(() => setLastRun(doc, "a", "run-1"));
    expect(hook.result.current[0].lastRunId).toBe("run-1");
  });

  it("does not re-render the list when someone types in a cell", () => {
    const { doc, hook, renders } = setup();
    const before = renders();
    const first = hook.result.current;
    act(() => orderedCells(doc)[0].source!.insert(0, "select 1"));
    expect(renders()).toBe(before);
    expect(hook.result.current).toBe(first);
  });

  it("picks up a change made between render and subscribe", () => {
    // Render reads the cells; then, before React subscribes, the doc changes
    // (in Phase 2, a remote update can land in that gap). The first observer
    // never sees it, so subscribe must refresh the cache.
    const doc = new Y.Doc();
    appendCell(doc, "sql", "a");
    let changeBeforeSubscribe = true;
    const hook = renderHook(() => {
      const cells = useCells(doc);
      if (changeBeforeSubscribe) {
        changeBeforeSubscribe = false;
        appendCell(doc, "sql", "b"); // during render: before effects subscribe
      }
      return cells;
    });
    expect(hook.result.current.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("shows the new doc's cells immediately when the doc is swapped", () => {
    const first = new Y.Doc();
    appendCell(first, "sql", "a");
    const second = new Y.Doc();
    appendCell(second, "sql", "x");
    const seen: { doc: Y.Doc; ids: string[] }[] = [];
    const hook = renderHook(
      ({ doc }) => {
        const cells = useCells(doc);
        seen.push({ doc, ids: cells.map((c) => c.id) });
        return cells;
      },
      { initialProps: { doc: first } },
    );
    hook.rerender({ doc: second });
    // Every render for the new doc, including the very first one, shows its
    // cells, never the previous doc's.
    const forSecond = seen.filter((r) => r.doc === second);
    expect(forSecond.length).toBeGreaterThan(0);
    for (const render of forSecond) expect(render.ids).toEqual(["x"]);
  });
});
