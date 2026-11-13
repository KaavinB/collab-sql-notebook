// @vitest-environment jsdom
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import { NotebookEditor } from "@/components/notebook/NotebookEditor";
import { ApiError, type ApiClient, type Notebook, type Run } from "@/lib/api";
import { appendCell, cellsMap, orderedCells, setLastRun } from "@/lib/notebook/doc";
import { fakeApi, NOTEBOOK, USER } from "@/test/fakeApi";
import { ticketFor } from "@/test/tickets";
import { fakeProviders } from "@/test/fakeSync";
import { resetConnections } from "@/lib/notebook/connections";

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

afterEach(() => {
  cleanup();
  resetConnections();
});

// The whole notebook renders in each test; under a loaded machine (the web and
// sync suites run in parallel) the default 1 s for findBy/waitFor was seen to
// be too short once.
configure({ asyncUtilTimeout: 5_000 });

function storedDocWithMarkdown(text: string): Uint8Array {
  const doc = new Y.Doc();
  appendCell(doc, "markdown", "stored");
  orderedCells(doc)[0].source!.insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

/** Renders the editor with a fake sync server; returns the API fake and the providers. */
function renderEditor(overrides: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi(overrides);
  const providers = fakeProviders();
  render(<NotebookEditor notebookId={NOTEBOOK.id} api={api} createProvider={providers.factory} />);
  /** Waits for the connection, then delivers the server's document. */
  const serve = async (state?: Uint8Array) => {
    await waitFor(() => expect(providers.created).toHaveLength(1));
    act(() => providers.latest().serve(state));
    // The page also waits for the notebook's metadata (getNotebook); only
    // once both have arrived is the notebook on screen. Asserting right after
    // serve() without this raced that request (it failed now and then under
    // load, showing "Connecting…" or "Loading notebook…").
    await screen.findByTestId("sync-status");
  };
  return { api, providers, serve };
}

describe("NotebookEditor", () => {
  it("shows the document only once the sync server has delivered it", async () => {
    const { serve } = renderEditor();
    expect(await screen.findByText("Connecting…")).toBeTruthy();
    await serve(storedDocWithMarkdown("# Stored work"));
    expect(await screen.findByRole("heading", { name: "Stored work" })).toBeTruthy();
    expect(screen.getByTestId("sync-status").textContent).toBe("Live");
  });

  it("shows a collaborator's edit as it arrives", async () => {
    const { providers, serve } = renderEditor();
    await serve();
    expect(await screen.findByText(/This notebook is empty/)).toBeTruthy();
    act(() => providers.latest().remote(storedDocWithMarkdown("# From Ada")));
    expect(await screen.findByRole("heading", { name: "From Ada" })).toBeTruthy();
  });

  it("keeps the notebook editable while offline, and says so", async () => {
    const { providers, serve } = renderEditor();
    await serve();
    act(() => providers.latest().drop());
    expect(screen.getByTestId("sync-status").textContent).toMatch(/^Offline/);
    fireEvent.click(screen.getByRole("button", { name: "+ SQL" }));
    expect(await screen.findByTestId("editor")).toBeTruthy();
  });

  it("turns view-only with the reason when the notebook is deleted", async () => {
    const { providers, serve } = renderEditor();
    await serve(storedDocWithMarkdown("# Notes"));
    act(() => providers.latest().close(4404));
    expect((await screen.findByTestId("sync-status")).textContent).toBe(
      "This notebook was deleted.",
    );
    expect(screen.queryByRole("button", { name: "+ SQL" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Notes" })).toBeTruthy(); // still readable
  });

  it("follows a role change pushed by the server", async () => {
    const syncTicket = vi
      .fn<ApiClient["syncTicket"]>()
      .mockResolvedValueOnce({
        ticket: ticketFor(USER.id, "1"),
        url: "ws://sync.test",
        role: "editor",
      })
      .mockResolvedValueOnce({
        ticket: ticketFor(USER.id, "2"),
        url: "ws://sync.test",
        role: "viewer",
      });
    const { providers, serve } = renderEditor({ syncTicket });
    await serve();
    expect(await screen.findByRole("button", { name: "+ SQL" })).toBeTruthy();
    act(() => providers.latest().close(4403));
    // Reconnects with the new ticket, now as a viewer: still live, view-only.
    await waitFor(() => expect(providers.latest().connects).toBe(1));
    act(() => providers.latest().serve());
    await waitFor(() => expect(screen.getByTestId("view-only")).toBeTruthy());
    expect(screen.getByTestId("sync-status").textContent).toBe("Live");
    expect(screen.queryByRole("button", { name: "+ SQL" })).toBeNull();
  });

  it("explains why it can't connect at all", async () => {
    renderEditor({
      syncTicket: vi.fn<ApiClient["syncTicket"]>(async () => {
        throw new ApiError(503, "unavailable", "Live collaboration is not configured.");
      }),
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Live collaboration is not configured.",
    );
  });

  it("shows a run someone else started, and stops once its lock has expired", async () => {
    const doc = new Y.Doc();
    appendCell(doc, "sql", "sql-1");
    const running = (expiresAt: string) => ({
      executionId: "e1",
      by: "Grace",
      startedAt: new Date().toISOString(),
      expiresAt,
    });
    // Far in the future, so a slow render can't race the expiry.
    cellsMap(doc)
      .get("sql-1")!
      .set("running", running(new Date(Date.now() + 3_600_000).toISOString()));
    const { providers, serve } = renderEditor();
    await serve(Y.encodeStateAsUpdate(doc));
    expect(await screen.findByText("Running… (started by Grace)")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Running…" }).disabled).toBe(true);
    // The same run, now past its lock's expiry (its API process died).
    const expired = new Y.Doc();
    Y.applyUpdate(expired, Y.encodeStateAsUpdate(providers.latest().doc));
    cellsMap(expired)
      .get("sql-1")!
      .set("running", running(new Date(Date.now() - 1).toISOString()));
    act(() =>
      providers
        .latest()
        .remote(Y.encodeStateAsUpdate(expired, Y.encodeStateVector(providers.latest().doc))),
    );
    await waitFor(() => expect(screen.queryByText(/started by Grace/)).toBeNull());
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
  });

  it("keeps offline edits when the page is left, and has them when it's reopened", async () => {
    const { providers, serve } = renderEditor();
    await serve();
    act(() => providers.latest().drop());
    fireEvent.click(screen.getByRole("button", { name: "+ SQL" }));
    cleanup(); // leave the page (e.g. "← Notebooks")
    expect(providers.latest().destroyed).toBe(false);

    render(
      <NotebookEditor
        notebookId={NOTEBOOK.id}
        api={fakeApi()}
        createProvider={providers.factory}
      />,
    );
    expect(providers.created).toHaveLength(1); // the same connection, not a new one
    // Still offline: the kept document shows at once, and can still be edited.
    expect(await screen.findByTestId("editor")).toBeTruthy(); // the offline cell is still there
    expect(screen.getByTestId("sync-status").textContent).toMatch(/^Offline/);
    expect(screen.getByRole("button", { name: "+ SQL" })).toBeTruthy();
  });

  it("shows who is here", async () => {
    const { providers, serve } = renderEditor();
    await serve();
    const awareness = providers.latest().awareness;
    act(() =>
      awareness.setLocalState({ user: { id: "u1", name: "Ada Lovelace", color: "#2563eb" } }),
    );
    const list = await screen.findByRole("list", { name: "People in this notebook" });
    expect(list.textContent).toBe("AL");
    expect(screen.getByLabelText("Ada Lovelace (you)")).toBeTruthy();
  });

  it("shows the AI assistant in the presence list, apart from the people", async () => {
    const { providers, serve } = renderEditor();
    await serve();
    const awareness = providers.latest().awareness;
    act(() =>
      awareness.setLocalState({ user: { id: "u1", name: "Ada Lovelace", color: "#2563eb" } }),
    );
    // The AI's entry as the sync server announces it, under its own client ID.
    const server = new Awareness(new Y.Doc());
    server.setLocalState({
      user: { id: "ai-assistant", name: "AI assistant", color: "#7c3aed" },
      cursor: null,
      ai: { cellId: "sql-1", status: "thinking" },
    });
    act(() =>
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(server, [server.clientID]), "server"),
    );
    const ai = await screen.findByLabelText("AI assistant (thinking)");
    expect(ai.textContent).toBe("AI");
    expect(ai.getAttribute("data-ai")).toBe("true");
    expect(ai.style.backgroundColor).toBe("rgb(124, 58, 237)");
    const list = screen.getByRole("list", { name: "People in this notebook" });
    expect(list.textContent).toBe("ALAI"); // you first, the AI last

    // It leaves when the server removes it.
    act(() => {
      server.setLocalState(null);
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(server, [server.clientID]), "server");
    });
    await waitFor(() => expect(screen.queryByLabelText(/AI assistant/)).toBeNull());
  });

  it("shows every member what the AI is doing in a cell, and offers a fix after a failed run", async () => {
    const doc = new Y.Doc();
    appendCell(doc, "sql", "sql-1");
    orderedCells(doc)[0].source!.insert(0, "select nope");
    setLastRun(doc, "sql-1", "r1");
    const failedRun: Run = {
      id: "r1",
      cell_id: "sql-1",
      sql: "select nope",
      status: "error",
      result: null,
      error: { kind: "error", message: "Binder Error: column nope not found" },
      created_at: "2026-11-13T07:00:00Z",
    };
    const { api, providers, serve } = renderEditor({ getRun: vi.fn(async () => failedRun) });
    await serve(Y.encodeStateAsUpdate(doc));
    fireEvent.click(await screen.findByRole("button", { name: "Fix with AI" }));
    await waitFor(() => expect(api.askAi).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.askAi).mock.calls[0].slice(0, 3)).toEqual([
      NOTEBOOK.id,
      "sql-1",
      { kind: "fix", sql: "select nope", error: "Binder Error: column nope not found" },
    ]);

    // The sync server reports the request in the document.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(providers.latest().doc));
    cellsMap(remote).get("sql-1")!.set("ai", {
      status: "thinking",
      requestId: "req-1",
      kind: "fix",
      by: "Grace",
      startedAt: "2026-11-13T10:00:00Z",
    });
    act(() =>
      providers
        .latest()
        .remote(Y.encodeStateAsUpdate(remote, Y.encodeStateVector(providers.latest().doc))),
    );
    expect(await screen.findByText("AI assistant is thinking… (asked by Grace)")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Fix with AI" }).disabled).toBe(
      true,
    );
  });

  it("renames on blur and reverts on Escape", async () => {
    const { api, serve } = renderEditor();
    await serve();
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

    async function renderAs(role: Notebook["role"]) {
      const { api, serve } = renderEditor({
        getNotebook: async () => ({ ...NOTEBOOK, role }),
        syncTicket: async () => ({ ticket: ticketFor(USER.id), url: "ws://sync.test", role }),
      });
      await serve(storedDocWithEveryCellType());
      return api;
    }

    it("gives a viewer a read-only notebook", async () => {
      const api = await renderAs("viewer");
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
    });

    it.each(["editor", "owner"] as const)("lets an %s edit and run", async (role) => {
      await renderAs(role);
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
    render(
      <NotebookEditor
        notebookId={NOTEBOOK.id}
        api={api}
        createProvider={fakeProviders().factory}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toBe("Notebook not found.");
  });
});
