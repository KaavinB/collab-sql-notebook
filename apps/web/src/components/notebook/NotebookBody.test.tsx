// @vitest-environment jsdom
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { LoadedNotebook } from "@/components/notebook/NotebookBody";
import type { Notebook, Run } from "@/lib/api";
import { appendCell, cellsMap, orderedCells, setLastRun } from "@/lib/notebook/doc";
import { EXAMPLE_SQL, markExampleNotebook, takeExampleMark } from "@/lib/notebook/example";
import { fakeApi, NOTEBOOK, SUGGESTION_ID } from "@/test/fakeApi";

// CodeMirror needs layout APIs jsdom lacks (covered by Playwright); a stand-in
// shows the text. Charts are drawn by Vega, tested on their own.
vi.mock("@/components/notebook/CodeEditor", () => ({
  CodeEditor: ({ text }: { text: Y.Text }) => <pre data-testid="editor">{text.toString()}</pre>,
}));
vi.mock("@/components/notebook/Chart", () => ({
  Chart: () => <div data-testid="chart" />,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

configure({ asyncUtilTimeout: 5_000 });
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

function renderNotebook(
  options: { doc?: Y.Doc; api?: ReturnType<typeof fakeApi>; notebook?: Notebook } = {},
) {
  const doc = options.doc ?? new Y.Doc();
  const api = options.api ?? fakeApi();
  const notebook = options.notebook ?? NOTEBOOK;
  render(
    <LoadedNotebook
      api={api}
      doc={doc}
      notebook={notebook}
      readOnly={notebook.role === "viewer"}
      status={<span data-testid="sync-status">Live</span>}
      presence={null}
    />,
  );
  return { doc, api };
}

const groupedResult = (id: string, cellId: string): Run => ({
  id,
  cell_id: cellId,
  sql: "select borough, count(*) as trips from zones group by all",
  status: "ok",
  result: {
    columns: [
      { name: "borough", type: "VARCHAR" },
      { name: "trips", type: "BIGINT" },
    ],
    rows: [
      ["Queens", 69],
      ["Bronx", 43],
    ],
    row_count: 2,
    truncated: false,
    duration_ms: 3,
  },
  error: null,
  created_at: "2026-11-13T07:00:00Z",
});

describe("a new, empty notebook", () => {
  it("asks a typed question in a new query cell", async () => {
    const { doc, api } = renderNotebook();
    expect(
      screen.getByRole("heading", { name: "Ask a question about NYC taxi trips" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Your question"), {
      target: { value: "Which borough tips most?" },
    });
    fireEvent.click(
      within(screen.getByRole("region", { name: "Start here" })).getByRole("button", {
        name: "Ask AI",
      }),
    );
    const cells = orderedCells(doc);
    expect(cells.map((c) => c.type)).toEqual(["sql"]);
    await waitFor(() =>
      expect(api.askAi).toHaveBeenCalledWith(
        NOTEBOOK.id,
        cells[0].id,
        { kind: "generate", prompt: "Which borough tips most?" },
        expect.any(AbortSignal),
      ),
    );
    // The empty state gives way to the cell.
    expect(screen.queryByRole("region", { name: "Start here" })).toBeNull();
  });

  it("asks an example question in one click", async () => {
    const { doc, api } = renderNotebook();
    fireEvent.click(screen.getByRole("button", { name: "Which pickup zones are the busiest?" }));
    await waitFor(() => expect(api.askAi).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.askAi).mock.calls[0][1]).toBe(orderedCells(doc)[0].id);
    expect(vi.mocked(api.askAi).mock.calls[0][2]).toEqual({
      kind: "generate",
      prompt: "Which pickup zones are the busiest?",
    });
  });

  it("shows a viewer that it's empty, and what they can do", () => {
    renderNotebook({ notebook: { ...NOTEBOOK, role: "viewer" } });
    expect(screen.getByText("This notebook is empty.")).toBeTruthy();
    expect(screen.queryByLabelText("Your question")).toBeNull();
    expect(screen.getByTestId("viewer-note").textContent).toMatch(/can view this notebook/);
  });
});

describe("the example notebook", () => {
  it("fills a notebook created as the example, and runs its query once", async () => {
    markExampleNotebook(NOTEBOOK.id);
    const { doc, api } = renderNotebook();
    await waitFor(() => expect(api.runCell).toHaveBeenCalledTimes(1));
    const sql = orderedCells(doc).find((c) => c.type === "sql")!;
    expect(vi.mocked(api.runCell).mock.calls[0].slice(0, 3)).toEqual([
      NOTEBOOK.id,
      sql.id,
      EXAMPLE_SQL,
    ]);
    // The run is stored and the cell points at it, so the chart can draw it.
    await waitFor(() =>
      expect(orderedCells(doc).find((c) => c.id === sql.id)!.lastRunId).toBe("r1"),
    );
    expect(screen.getByRole("heading", { name: "Welcome to your first notebook" })).toBeTruthy();
  });

  it("never seeds for a viewer", async () => {
    markExampleNotebook(NOTEBOOK.id);
    const { doc, api } = renderNotebook({ notebook: { ...NOTEBOOK, role: "viewer" } });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(orderedCells(doc)).toHaveLength(0);
    expect(api.runCell).not.toHaveBeenCalled();
    takeExampleMark(NOTEBOOK.id);
  });

  it("never seeds a document that already has cells", async () => {
    markExampleNotebook(NOTEBOOK.id);
    const doc = new Y.Doc();
    appendCell(doc, "markdown", "m1");
    const { api } = renderNotebook({ doc });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(orderedCells(doc).map((c) => c.id)).toEqual(["m1"]);
    expect(api.runCell).not.toHaveBeenCalled();
  });

  it("leaves an ordinary notebook alone", async () => {
    const { doc, api } = renderNotebook();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(orderedCells(doc)).toHaveLength(0);
    expect(api.runCell).not.toHaveBeenCalled();
  });
});

describe("a query cell", () => {
  it("makes a chart of a result in one click, right after the query", async () => {
    const doc = new Y.Doc();
    appendCell(doc, "sql", "q1");
    appendCell(doc, "markdown", "m1");
    orderedCells(doc)[0].source!.insert(
      0,
      "select borough, count(*) as trips from zones group by all",
    );
    setLastRun(doc, "q1", "r1");
    renderNotebook({
      doc,
      api: fakeApi({ getRun: vi.fn(async () => groupedResult("r1", "q1")) }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Make a chart" }));
    const cells = orderedCells(doc);
    expect(cells.map((c) => c.type)).toEqual(["sql", "chart", "markdown"]);
    expect(cells[1].chart).toMatchObject({ source: "q1", mark: "bar", x: "borough", y: "trips" });
    expect(await screen.findByTestId("chart")).toBeTruthy();
  });

  it("explains a failed run in plain words, with Fix with AI as the way out", async () => {
    const doc = new Y.Doc();
    appendCell(doc, "sql", "q1");
    orderedCells(doc)[0].source!.insert(0, "select pickup_zone from trips");
    setLastRun(doc, "q1", "r1");
    const failed: Run = {
      id: "r1",
      cell_id: "q1",
      sql: "select pickup_zone from trips",
      status: "error",
      result: null,
      error: {
        kind: "error",
        message:
          'Binder Error: Referenced column "pickup_zone" not found in FROM clause!\nCandidate bindings: "pickup_at"',
      },
      created_at: "2026-11-13T07:00:00Z",
    };
    const { api } = renderNotebook({ doc, api: fakeApi({ getRun: vi.fn(async () => failed) }) });
    const panel = await screen.findByTestId("run-error");
    expect(within(panel).getByTestId("run-error-title").textContent).toBe(
      "There's no column called “pickup_zone”.",
    );
    // The database's own words are still there, under Details.
    expect(within(panel).queryByText(/Binder Error/)).toBeNull();
    const details = panel.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(within(panel).getByText(/Binder Error/, { selector: "pre" })).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Fix with AI" }));
    await waitFor(() => expect(api.askAi).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.askAi).mock.calls[0][2]).toMatchObject({
      kind: "fix",
      sql: "select pickup_zone from trips",
    });
  });

  it("accepts a suggestion and runs it, so the person sees an answer", async () => {
    const doc = new Y.Doc();
    appendCell(doc, "sql", "q1");
    cellsMap(doc).get("q1")!.set("ai", {
      status: "suggestion",
      requestId: "req-1",
      suggestionId: SUGGESTION_ID,
      kind: "generate",
      sql: "select count(*) from trips",
      explanation: "Counts the trips.",
      baseSql: null,
      valid: true,
      by: "Ada",
    });
    const { api } = renderNotebook({ doc });
    fireEvent.click(await screen.findByRole("button", { name: "Accept and run" }));
    await waitFor(() => expect(api.runCell).toHaveBeenCalledTimes(1));
    expect(api.decideSuggestion).toHaveBeenCalledWith(NOTEBOOK.id, SUGGESTION_ID, "accepted");
    // Decided first, then run with the accepted SQL.
    expect(vi.mocked(api.decideSuggestion).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.runCell).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(api.runCell).mock.calls[0][2]).toBe("select count(*) from trips");
  });

  it("can't be run while it's empty, and says why", () => {
    const doc = new Y.Doc();
    appendCell(doc, "sql", "q1");
    renderNotebook({ doc });
    const run = screen.getByRole<HTMLButtonElement>("button", { name: "Run" });
    expect(run.disabled).toBe(true);
    expect(run.title).toMatch(/first/);
  });
});

describe("a text cell", () => {
  it("has Edit in its header, always visible, and Done in its editor", () => {
    const doc = new Y.Doc();
    appendCell(doc, "markdown", "m1");
    orderedCells(doc)[0].source!.insert(0, "# Notes");
    renderNotebook({ doc });
    const cell = screen.getByRole("region", { name: "Text cell 1" });
    const header = cell.querySelector("header")!;
    fireEvent.click(within(header).getByRole("button", { name: "Edit" }));
    expect(within(cell).getByTestId("editor")).toBeTruthy();
    expect(within(header).queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.click(within(cell).getByRole("button", { name: "Done" }));
    expect(within(cell).getByRole("heading", { name: "Notes" })).toBeTruthy();
  });
});

describe("the header", () => {
  function renderWithStatus(text: string) {
    render(
      <LoadedNotebook
        api={fakeApi()}
        doc={new Y.Doc()}
        notebook={NOTEBOOK}
        readOnly={false}
        status={<span data-testid="sync-status">{text}</span>}
        presence={null}
      />,
    );
    return screen.getByTestId("sync-status").parentElement!;
  }

  it("explains there's no Save button only while live", () => {
    expect(renderWithStatus("Live").title).toMatch(/no Save button/);
    cleanup();
    const sentence = "Offline. Unsynced edits will sync when you reconnect.";
    const pill = renderWithStatus(sentence);
    // A long status shows on one line, with the whole sentence in the tooltip.
    expect(pill.title).toBe(sentence);
    expect(pill.className).toMatch(/truncate/);
  });
});

describe("adding cells and finding help", () => {
  it("adds a query cell to ask from, and the plain cell types", () => {
    const doc = new Y.Doc();
    appendCell(doc, "markdown", "m1");
    renderNotebook({ doc });
    fireEvent.click(screen.getByRole("button", { name: "Ask a question" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Chart" }));
    expect(orderedCells(doc).map((c) => c.type)).toEqual(["markdown", "sql", "chart"]);
  });

  it("opens the data guide, and asks one of its questions in a new cell", async () => {
    const { doc, api } = renderNotebook();
    fireEvent.click(screen.getByRole("button", { name: "About the data" }));
    const guide = screen.getByRole("dialog", { name: "About the data" });
    expect(within(guide).getByText("payment_type")).toBeTruthy();
    expect(within(guide).getByText("Cash")).toBeTruthy();
    fireEvent.click(
      within(guide).getByRole("button", { name: "Which day of the week has the longest trips?" }),
    );
    expect(screen.queryByRole("dialog", { name: "About the data" })).toBeNull();
    await waitFor(() => expect(api.askAi).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.askAi).mock.calls[0][1]).toBe(orderedCells(doc)[0].id);
  });

  it("closes the data guide with Escape", () => {
    renderNotebook();
    fireEvent.click(screen.getByRole("button", { name: "About the data" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "About the data" })).toBeNull();
  });

  it("lists the keyboard shortcuts", () => {
    renderNotebook();
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByText("Ctrl / ⌘ + Enter")).toBeTruthy();
  });

  it("gives viewers the guide without the ask buttons", () => {
    renderNotebook({ notebook: { ...NOTEBOOK, role: "viewer" } });
    fireEvent.click(screen.getByRole("button", { name: "About the data" }));
    const guide = screen.getByRole("dialog", { name: "About the data" });
    expect(within(guide).queryByRole("button", { name: /busiest/ })).toBeNull();
    expect(within(guide).getByText("Which pickup zones are the busiest?")).toBeTruthy();
  });
});
