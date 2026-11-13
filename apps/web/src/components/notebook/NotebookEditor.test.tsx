// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { NotebookEditor } from "@/components/notebook/NotebookEditor";
import { ApiError, type ApiClient } from "@/lib/api";
import { appendCell, orderedCells } from "@/lib/notebook/doc";
import { deferred, fakeApi, NOTEBOOK } from "@/test/fakeApi";

// CodeMirror needs real layout APIs that jsdom lacks; the editor binding is
// covered by the Playwright tests. Here it's a stand-in that shows the text.
vi.mock("@/components/notebook/CodeEditor", () => ({
  CodeEditor: ({ text }: { text: Y.Text }) => <pre data-testid="editor">{text.toString()}</pre>,
}));
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
