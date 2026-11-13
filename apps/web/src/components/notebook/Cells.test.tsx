// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { CellFrame, MarkdownCellBody, SqlCellBody } from "@/components/notebook/Cells";
import { appendCell, orderedCells, setLastRun } from "@/lib/notebook/doc";
import { okRun } from "@/test/fakeApi";

const editorProps = vi.fn();
vi.mock("@/components/notebook/CodeEditor", () => ({
  CodeEditor: (props: { readOnly?: boolean; onSubmit?: () => void }) => {
    editorProps(props);
    return <pre data-testid="editor" />;
  },
}));
afterEach(() => {
  cleanup();
  editorProps.mockReset();
});

function cell(type: "sql" | "markdown", text: string) {
  const doc = new Y.Doc();
  appendCell(doc, type, "c1");
  orderedCells(doc)[0].source!.insert(0, text);
  return { doc, view: () => orderedCells(doc)[0] };
}

describe("view-only cells", () => {
  it("has no move or delete buttons in a viewer's cell frame", () => {
    const { view } = cell("sql", "select 1");
    const frame = (readOnly: boolean) => (
      <CellFrame
        cell={view()}
        index={0}
        count={2}
        onMove={vi.fn()}
        onDelete={vi.fn()}
        readOnly={readOnly}
      >
        body
      </CellFrame>
    );
    const { rerender } = render(frame(false));
    expect(screen.getByRole("button", { name: "Delete cell" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move cell down" })).toBeTruthy();
    rerender(frame(true));
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("shows a viewer's SQL read-only, with no way to run it", () => {
    const { doc, view } = cell("sql", "select 2");
    setLastRun(doc, "c1", "r1");
    const runs = new Map([["r1", { ...okRun("r1", 1), sql: "select 1" }]]);
    render(
      <SqlCellBody
        cell={view()}
        source={view().source!}
        state={{ status: "idle" }}
        runs={runs}
        loadFailures={new Map()}
        ensureRun={vi.fn()}
        onRun={vi.fn()}
        readOnly
      />,
    );
    expect(editorProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ readOnly: true, onSubmit: undefined }),
    );
    // Told the result is stale, but not told to run (they can't).
    const stale = screen.getByTestId("stale-result").textContent ?? "";
    expect(stale).toMatch(/earlier version/);
    expect(stale).not.toMatch(/Run the cell/);
  });

  it("always shows a viewer's markdown rendered, never the editor", () => {
    const { view } = cell("markdown", "# Hello");
    render(<MarkdownCellBody source={view().source!} readOnly />);
    expect(screen.getByRole("heading", { name: "Hello" })).toBeTruthy();
    expect(screen.queryByTestId("editor")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("shows an empty markdown cell as empty to a viewer, not as an editor", () => {
    const { view } = cell("markdown", "");
    render(<MarkdownCellBody source={view().source!} readOnly />);
    expect(screen.getByText("Empty markdown cell.")).toBeTruthy();
    expect(screen.queryByTestId("editor")).toBeNull();
  });
});
