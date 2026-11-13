// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { SqlCellBody } from "@/components/notebook/Cells";
import type { RunState } from "@/components/notebook/useRuns";
import type { Run } from "@/lib/api";
import { appendCell, orderedCells, setLastRun } from "@/lib/notebook/doc";
import { okRun } from "@/test/fakeApi";

vi.mock("@/components/notebook/CodeEditor", () => ({ CodeEditor: () => null }));
afterEach(cleanup);

function setup(text: string, runSql: string, state: RunState = { status: "idle" }) {
  const doc = new Y.Doc();
  appendCell(doc, "sql", "c1");
  const source = orderedCells(doc)[0].source!;
  source.insert(0, text);
  setLastRun(doc, "c1", "r1");
  const run: Run = { ...okRun("r1", 1), sql: runSql };
  const runs = new Map([["r1", run]]);
  const props = { source, runs, loadFailures: new Map(), ensureRun: vi.fn(), onRun: vi.fn() };
  const view = render(<SqlCellBody cell={orderedCells(doc)[0]} state={state} {...props} />);
  return { source, view, props, doc };
}

describe("SqlCellBody", () => {
  it("marks a result that came from different SQL than the editor holds", () => {
    const { source } = setup("select 1", "select 1");
    expect(screen.queryByTestId("stale-result")).toBeNull();
    act(() => source.insert(source.length, " + 1"));
    expect(screen.getByTestId("stale-result").textContent).toMatch(/earlier version/);
  });

  it("ignores whitespace-only differences", () => {
    setup("  select 1\n", "select 1");
    expect(screen.queryByTestId("stale-result")).toBeNull();
  });

  it("hides the marker while a run is in flight", () => {
    setup("select 2", "select 1", { status: "running" });
    expect(screen.queryByTestId("stale-result")).toBeNull();
  });

  it("says when a Run was ignored because the cell is already running", () => {
    setup("select 1", "select 1", { status: "running", ignoredSubmit: true });
    expect(screen.getByRole("status").textContent).toMatch(/Already running/);
  });

  it("just says Running… for an ordinary run", () => {
    setup("select 1", "select 1", { status: "running" });
    expect(screen.getByRole("status").textContent).toBe("Running…");
  });
});
