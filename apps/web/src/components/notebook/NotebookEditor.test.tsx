// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { NotebookEditor } from "@/components/notebook/NotebookEditor";
import { ApiError, type ApiClient, type Notebook } from "@/lib/api";
import { appendCell, orderedCells, setLastRun } from "@/lib/notebook/doc";
import { deferred, fakeApi, NOTEBOOK } from "@/test/fakeApi";

// CodeMirror needs real layout APIs that jsdom lacks; the editor binding is
// covered by the Playwright tests. Here it's a stand-in that shows the text.
vi.mock("@/components/notebook/CodeEditor", () => ({
  CodeEditor: ({ text, readOnly }: { text: Y.Text; readOnly?: boolean }) => (
    <pre data-testid="editor" data-readonly={String(Boolean(readOnly))}>
      {text.toString()}
    </pre>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

afterEach(cleanup);

function storedDocWithMarkdown(text: string): Uint8Array {
  const doc = new Y.Doc();
  appendCell(doc, "markdown", "stored");
  orderedCells(doc)[0].source!.insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

function textsIn(state: Uint8Array): string[] {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return orderedCells(doc).map((c) => c.source?.toString() ?? "");
}

describe("NotebookEditor", () => {
  it("never saves before the stored document is loaded, and keeps it when saving", async () => {
    const snapshot = deferred<Uint8Array | null>();
    const saveSnapshot = vi.fn<ApiClient["saveSnapshot"]>(async () => {});
    const api = fakeApi({ loadSnapshot: () => snapshot.promise, saveSnapshot });
    render(<NotebookEditor notebookId={NOTEBOOK.id} api={api} />);
    expect(screen.getByText("Loading notebook…")).toBeTruthy();

    await act(async () => snapshot.resolve(storedDocWithMarkdown("# Stored work")));
    await screen.findByRole("button", { name: "+ SQL" });
    expect(saveSnapshot).not.toHaveBeenCalled(); // loading alone saves nothing

    fireEvent.click(screen.getByRole("button", { name: "+ SQL" }));
    await waitFor(() => expect(saveSnapshot).toHaveBeenCalled(), { timeout: 3000 });
    const saved = saveSnapshot.mock.calls.at(-1)![1];
    expect(textsIn(saved)).toEqual(["# Stored work", ""]);
  });

  it("says plainly when a save can't succeed, and stops retrying", async () => {
    const api = fakeApi({
      saveSnapshot: vi.fn(async () => {
        throw new ApiError(404, "not_found", "Notebook not found.");
      }),
    });
    render(<NotebookEditor notebookId={NOTEBOOK.id} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "+ SQL" }));
    await waitFor(
      () =>
        expect(screen.getByTestId("save-status").textContent).toBe(
          "Not saved: Notebook not found.",
        ),
      { timeout: 3000 },
    );
    expect(screen.getByTestId("save-status").getAttribute("role")).toBe("alert");
    await new Promise((resolve) => setTimeout(resolve, 1500)); // past the first retry delay
    expect(api.saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it("says it's retrying when the failure is temporary", async () => {
    const api = fakeApi({
      saveSnapshot: vi.fn(async () => {
        throw new ApiError(503, "busy", "busy");
      }),
    });
    render(<NotebookEditor notebookId={NOTEBOOK.id} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "+ SQL" }));
    await waitFor(
      () => expect(screen.getByTestId("save-status").textContent).toBe("Not saved — retrying"),
      { timeout: 3000 },
    );
  });

  it("renames on blur and reverts on Escape", async () => {
    const api = fakeApi();
    render(<NotebookEditor notebookId={NOTEBOOK.id} api={api} />);
    const title = await screen.findByLabelText<HTMLInputElement>("Notebook title");

    fireEvent.change(title, { target: { value: "Tips by borough" } });
    fireEvent.blur(title);
    await waitFor(() =>
      expect(api.renameNotebook).toHaveBeenCalledWith(NOTEBOOK.id, "Tips by borough"),
    );

    fireEvent.change(title, { target: { value: "Oops" } });
    fireEvent.keyDown(title, { key: "Escape" });
    await waitFor(() => expect(title.value).toBe("Tips by borough"));
    expect(api.renameNotebook).toHaveBeenCalledTimes(1);
  });

  describe("by role", () => {
    // One cell of each type, the SQL cell already run.
    function storedDocWithEveryCellType(): Uint8Array {
      const doc = new Y.Doc();
      appendCell(doc, "sql", "sql-1");
      orderedCells(doc)[0].source!.insert(0, "select 1");
      setLastRun(doc, "sql-1", "r1");
      appendCell(doc, "markdown", "md-1");
      orderedCells(doc)[1].source!.insert(0, "# Notes");
      appendCell(doc, "chart", "chart-1");
      return Y.encodeStateAsUpdate(doc);
    }

    function renderAs(role: Notebook["role"]) {
      const api = fakeApi({
        getNotebook: async () => ({ ...NOTEBOOK, role }),
        loadSnapshot: async () => storedDocWithEveryCellType(),
      });
      render(<NotebookEditor notebookId={NOTEBOOK.id} api={api} />);
      return api;
    }

    it("gives a viewer a read-only notebook", async () => {
      const api = renderAs("viewer");
      expect((await screen.findByTestId("view-only")).textContent).toBe("View only");
      expect(screen.getByRole("heading", { name: NOTEBOOK.title })).toBeTruthy();
      expect(screen.queryByLabelText("Notebook title")).toBeNull();
      for (const name of ["Run", "Move cell up", "Move cell down", "Delete cell", "Edit"]) {
        expect(screen.queryByRole("button", { name })).toBeNull();
      }
      for (const name of ["+ SQL", "+ Markdown", "+ Chart"]) {
        expect(screen.queryByRole("button", { name })).toBeNull();
      }
      // The SQL is shown read-only; the markdown is shown rendered.
      expect(screen.getByTestId("editor").getAttribute("data-readonly")).toBe("true");
      expect(screen.getByRole("heading", { name: "Notes" })).toBeTruthy();
      // The chart's settings are visible but can't be changed.
      const chartData = screen.getByLabelText<HTMLSelectElement>("Chart data");
      expect(chartData.disabled).toBe(true);
      // They can still see the last result and the members.
      await waitFor(() => expect(api.getRun).toHaveBeenCalledWith(NOTEBOOK.id, "r1"));
      expect(screen.getByRole("button", { name: "Members" })).toBeTruthy();
      expect(api.saveSnapshot).not.toHaveBeenCalled();
    });

    it.each(["editor", "owner"] as const)("lets an %s edit and run", async (role) => {
      renderAs(role);
      expect(await screen.findByLabelText("Notebook title")).toBeTruthy();
      expect(screen.queryByTestId("view-only")).toBeNull();
      expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
      expect(screen.getAllByRole("button", { name: "Delete cell" })).toHaveLength(3);
      expect(screen.getByRole("button", { name: "+ SQL" })).toBeTruthy();
      expect(screen.getByTestId("editor").getAttribute("data-readonly")).toBe("false");
      expect(screen.getByLabelText<HTMLSelectElement>("Chart data").disabled).toBe(false);
      expect(
        screen.getByRole("button", { name: role === "owner" ? "Share" : "Members" }),
      ).toBeTruthy();
    });
  });

  it("shows the API's message when the notebook can't be loaded", async () => {
    const api = fakeApi({
      getNotebook: async () => {
        throw new ApiError(404, "not_found", "Notebook not found.");
      },
    });
    render(<NotebookEditor notebookId={NOTEBOOK.id} api={api} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Notebook not found.");
  });
});
