// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { AiAssist, type FailedRun } from "@/components/notebook/AiAssist";
import { ApiError, type ApiClient, type Suggestion } from "@/lib/api";
import { appendCell, cellsMap, orderedCells } from "@/lib/notebook/doc";
import { queueQuestion, takeQuestion } from "@/lib/notebook/pendingQuestions";
import { useCells } from "@/lib/notebook/useCells";
import { deferred, fakeApi, NOTEBOOK, SUGGESTION_ID, suggestion } from "@/test/fakeApi";

afterEach(cleanup);

const CELL = "c1";

/** Renders the assistant from the document, as the notebook does. */
function Harness(props: {
  api: ApiClient;
  doc: Y.Doc;
  readOnly: boolean;
  failedRun: FailedRun | null;
}) {
  const cell = useCells(props.doc).find((c) => c.id === CELL)!;
  return (
    <AiAssist
      api={props.api}
      notebookId={NOTEBOOK.id}
      doc={props.doc}
      cellId={CELL}
      source={cell.source!}
      ai={cell.ai}
      failedRun={props.failedRun}
      readOnly={props.readOnly}
    />
  );
}

function setup(
  options: {
    text?: string;
    ai?: unknown;
    readOnly?: boolean;
    failedRun?: FailedRun | null;
    api?: ReturnType<typeof fakeApi>;
  } = {},
) {
  const doc = new Y.Doc();
  appendCell(doc, "sql", CELL);
  const source = orderedCells(doc)[0].source!;
  source.insert(0, options.text ?? "select 1");
  if (options.ai) cellsMap(doc).get(CELL)!.set("ai", options.ai);
  const api = options.api ?? fakeApi();
  render(
    <Harness
      api={api}
      doc={doc}
      readOnly={options.readOnly ?? false}
      failedRun={options.failedRun ?? null}
    />,
  );
  /** The sync server writing the cell's AI state. */
  const setAi = (value: unknown) => act(() => cellsMap(doc).get(CELL)!.set("ai", value));
  return { doc, api, source, setAi };
}

const thinking = (by = "Ada") => ({
  status: "thinking",
  requestId: "req-1",
  kind: "generate",
  by,
  startedAt: "2026-11-13T10:00:00Z",
});

const suggestionState = (overrides: Record<string, unknown> = {}) => ({
  status: "suggestion",
  requestId: "req-1",
  suggestionId: SUGGESTION_ID,
  kind: "generate",
  sql: "select count(*) from trips",
  explanation: "Counts the trips.",
  baseSql: null,
  valid: true,
  by: "Ada",
  ...overrides,
});

const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });

describe("asking the AI", () => {
  it("sends a plain-English question and clears it once answered", async () => {
    const { api } = setup();
    const input = screen.getByLabelText<HTMLInputElement>("Ask AI");
    expect(button("Ask AI").disabled).toBe(true); // nothing to ask yet
    fireEvent.change(input, { target: { value: "  trips per hour  " } });
    fireEvent.click(button("Ask AI"));
    await waitFor(() => expect(input.value).toBe(""));
    expect(api.askAi).toHaveBeenCalledWith(
      NOTEBOOK.id,
      CELL,
      { kind: "generate", prompt: "trips per hour" },
      expect.any(AbortSignal),
    );
  });

  it("asks for an explanation of the cell's current SQL", async () => {
    const { api, source } = setup();
    act(() => source.insert(8, " + 1"));
    fireEvent.click(button("Explain"));
    await waitFor(() => expect(api.askAi).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.askAi).mock.calls[0][2]).toEqual({ kind: "explain", sql: "select 1 + 1" });
  });

  it("offers Fix with AI only after a failed run, sending that run's SQL and error", async () => {
    setup();
    expect(screen.queryByRole("button", { name: "Fix with AI" })).toBeNull();
    cleanup();
    const { api } = setup({ failedRun: { sql: "select nope", error: "Binder Error: nope" } });
    fireEvent.click(button("Fix with AI"));
    await waitFor(() => expect(api.askAi).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.askAi).mock.calls[0][2]).toEqual({
      kind: "fix",
      sql: "select nope",
      error: "Binder Error: nope",
    });
  });

  it("sends one request for a double click, and says it's asking", async () => {
    const pending = deferred<Suggestion>();
    const { api } = setup({ api: fakeApi({ askAi: vi.fn(() => pending.promise) }) });
    fireEvent.click(button("Explain"));
    fireEvent.click(button("Explain"));
    expect(api.askAi).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("Asking the AI assistant…");
    expect(button("Explain").disabled).toBe(true);
    await act(async () => pending.resolve(suggestion()));
    expect(button("Explain").disabled).toBe(false);
  });

  it("shows why the API refused, until dismissed", async () => {
    setup({
      api: fakeApi({
        askAi: vi.fn(async () => {
          throw new ApiError(409, "busy", "The AI assistant is already working on this cell.");
        }),
      }),
    });
    fireEvent.click(button("Explain"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already working/);
    fireEvent.click(button("Dismiss"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("doesn't repeat a failure the document already shows", async () => {
    const pending = deferred<Suggestion>();
    const { setAi } = setup({ api: fakeApi({ askAi: vi.fn(() => pending.promise) }) });
    fireEvent.click(button("Explain"));
    setAi(thinking());
    setAi({ status: "failed", requestId: "req-1", message: "The model refused." });
    await act(async () => pending.reject(new ApiError(502, "ai_failed", "The model refused.")));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("shows a 502 ai_failed answer, then the document's own failure in its place", async () => {
    const message = "The AI assistant declined to answer.";
    const { setAi } = setup({
      api: fakeApi({
        askAi: vi.fn(async () => {
          throw new ApiError(502, "ai_failed", message);
        }),
      }),
    });
    fireEvent.click(button("Explain"));
    expect((await screen.findByRole("alert")).textContent).toMatch(message);
    setAi({ status: "failed", requestId: "req-1", message });
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toMatch(`The AI assistant couldn't help: ${message}`);
  });

  it("refuses SQL longer than the API accepts, without asking", () => {
    const { api } = setup({ text: "x".repeat(20_001) });
    fireEvent.click(button("Explain"));
    expect(screen.getByRole("alert").textContent).toMatch(/too long/);
    expect(api.askAi).not.toHaveBeenCalled();
  });

  it("gives viewers no way to ask", () => {
    setup({ readOnly: true, failedRun: { sql: "x", error: "y" } });
    expect(screen.queryByLabelText("Ask AI")).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("sends a question queued for the cell when it was created, once", async () => {
    queueQuestion(CELL, "busiest zones?");
    const { api } = setup();
    await waitFor(() => expect(api.askAi).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.askAi).mock.calls[0].slice(1, 3)).toEqual([
      CELL,
      { kind: "generate", prompt: "busiest zones?" },
    ]);
    cleanup();
    const again = setup();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(again.api.askAi).not.toHaveBeenCalled();
  });

  it("never sends a queued question for a viewer", async () => {
    queueQuestion(CELL, "busiest zones?");
    const { api } = setup({ readOnly: true });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(api.askAi).not.toHaveBeenCalled();
    takeQuestion(CELL);
  });
});

describe("accept and run", () => {
  function setupWithRun(options: { text?: string; ai?: unknown } = {}) {
    const doc = new Y.Doc();
    appendCell(doc, "sql", CELL);
    orderedCells(doc)[0].source!.insert(0, options.text ?? "");
    if (options.ai) cellsMap(doc).get(CELL)!.set("ai", options.ai);
    const api = fakeApi();
    const onRun = vi.fn(() => orderedCells(doc)[0].source!.toString());
    function WithRun() {
      const cell = useCells(doc).find((c) => c.id === CELL)!;
      return (
        <AiAssist
          api={api}
          notebookId={NOTEBOOK.id}
          doc={doc}
          cellId={CELL}
          source={cell.source!}
          ai={cell.ai}
          failedRun={null}
          readOnly={false}
          onRun={onRun}
        />
      );
    }
    render(<WithRun />);
    return { api, onRun };
  }

  it("is offered only when the cell can be run", () => {
    setup({ ai: suggestionState() });
    expect(screen.queryByRole("button", { name: "Accept and run" })).toBeNull();
    cleanup();
    setupWithRun({ ai: suggestionState() });
    expect(button("Accept and run")).toBeTruthy();
  });

  it("leads with Accept and run for a checked query, and with Accept for an unchecked one", () => {
    const order = () =>
      screen
        .getAllByRole("button")
        .map((b) => b.textContent)
        .filter((name) => name?.startsWith("Accept"));
    setupWithRun({ ai: suggestionState() });
    expect(order()).toEqual(["Accept and run", "Accept"]);
    expect(button("Accept and run").className).toMatch(/bg-emerald/);
    cleanup();
    setupWithRun({ ai: suggestionState({ valid: false }) });
    expect(order()).toEqual(["Accept", "Accept and run"]);
    expect(button("Accept").className).toMatch(/bg-emerald/);
    expect(button("Accept and run").className).not.toMatch(/bg-emerald/);
  });

  it("runs the cell after the accepted SQL is in it", async () => {
    const { api, onRun } = setupWithRun({ ai: suggestionState() });
    fireEvent.click(button("Accept and run"));
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(api.decideSuggestion).toHaveBeenCalledWith(NOTEBOOK.id, SUGGESTION_ID, "accepted");
    expect(onRun.mock.results[0].value).toBe("select count(*) from trips");
  });

  it("still asks before replacing SQL, then runs", async () => {
    const { onRun } = setupWithRun({ text: "select 42", ai: suggestionState() });
    fireEvent.click(button("Accept and run"));
    expect(screen.getByRole("alert").textContent).toMatch(/already has SQL in it/);
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(button("Replace anyway"));
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
  });

  it("doesn't run when the decision failed", async () => {
    const { api, onRun } = setupWithRun({ ai: suggestionState() });
    vi.mocked(api.decideSuggestion).mockRejectedValueOnce(
      new ApiError(409, "conflict", "Already decided."),
    );
    fireEvent.click(button("Accept and run"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already accepted or rejected/);
    expect(onRun).not.toHaveBeenCalled();
  });
});

describe("while the AI is thinking", () => {
  it("tells an editor who asked, and blocks another request on the cell", () => {
    setup({ ai: thinking("Grace"), failedRun: { sql: "x", error: "y" } });
    expect(screen.getByRole("status").textContent).toBe(
      "AI assistant is thinking… (asked by Grace)",
    );
    fireEvent.change(screen.getByLabelText("Ask AI"), { target: { value: "q" } });
    for (const name of ["Ask AI", "Explain", "Fix with AI"])
      expect(button(name).disabled).toBe(true);
  });

  it("tells a viewer too", () => {
    setup({ ai: thinking(), readOnly: true });
    expect(screen.getByRole("status").textContent).toBe("AI assistant is thinking… (asked by Ada)");
  });
});

describe("a failed request", () => {
  it("shows its message to everyone, dismissable locally until the next failure", () => {
    const { setAi } = setup({ readOnly: true });
    setAi({ status: "failed", requestId: "req-1", message: "No API key is configured." });
    expect(screen.getByRole("alert").textContent).toMatch(/No API key is configured\./);
    fireEvent.click(button("Dismiss"));
    expect(screen.queryByRole("alert")).toBeNull();
    setAi({ status: "failed", requestId: "req-2", message: "Try again." });
    expect(screen.getByRole("alert").textContent).toMatch(/Try again\./);
  });
});

describe("a suggestion", () => {
  it("shows what it is, its SQL and whether it passed validation", () => {
    setup({ ai: suggestionState() });
    const card = screen.getByRole("region", { name: "AI suggestion" });
    expect(card.textContent).toMatch(/Generated SQL/);
    expect(card.textContent).toMatch(/asked by Ada/);
    expect(screen.getByTestId("ai-explanation").textContent).toBe("Counts the trips.");
    expect(screen.getByTestId("ai-sql").textContent).toBe("select count(*) from trips");
    expect(screen.getByTestId("ai-validation").textContent).toMatch(/^Checked/);
    expect(button("Accept")).toBeTruthy();
    expect(button("Reject")).toBeTruthy();
    // A pending suggestion has to be decided before asking again.
    expect(button("Explain").disabled).toBe(true);
  });

  it("labels a fix's current and suggested SQL, and an unvalidated query", () => {
    setup({
      ai: suggestionState({ kind: "fix", baseSql: "select 1", sql: "select 2", valid: false }),
      text: "select 1",
    });
    expect(screen.getByText("Current SQL (replaced)")).toBeTruthy();
    expect(screen.getByTestId("ai-base-sql").textContent).toBe("select 1");
    expect(screen.getByText("Suggested fix", { selector: "p" })).toBeTruthy();
    expect(screen.getByTestId("ai-sql").textContent).toBe("select 2");
    expect(screen.getByTestId("ai-validation").textContent).toMatch(/^Not checked/);
  });

  it("is read-only for viewers", () => {
    setup({ ai: suggestionState(), readOnly: true });
    expect(screen.getByRole("region", { name: "AI suggestion" })).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("renders the model's words as plain text, never as HTML or markdown", () => {
    const hostile = '<img src=x onerror="alert(1)"> **bold** [link](javascript:alert(1))';
    setup({ ai: suggestionState({ explanation: hostile, sql: "<script>alert(1)</script>" }) });
    const card = screen.getByRole("region", { name: "AI suggestion" });
    expect(card.querySelector("img, script, strong, a")).toBeNull();
    expect(screen.getByTestId("ai-explanation").textContent).toBe(hostile);
    expect(screen.getByTestId("ai-sql").textContent).toBe("<script>alert(1)</script>");
  });

  it("disappears when the document clears it", () => {
    const { setAi } = setup({ ai: suggestionState() });
    setAi(null);
    expect(screen.queryByRole("region", { name: "AI suggestion" })).toBeNull();
  });

  it("gives an explanation no validation badge (there's no SQL to validate)", () => {
    setup({
      ai: suggestionState({ kind: "explain", sql: null, baseSql: "select 1", valid: false }),
    });
    expect(screen.queryByTestId("ai-validation")).toBeNull();
    expect(screen.queryByText(/Not checked/)).toBeNull();
  });
});

describe("deciding", () => {
  it("accepts: records it first, then puts the SQL in the cell in one transaction", async () => {
    const decision = deferred<Suggestion>();
    const { api, doc, source } = setup({
      text: "",
      ai: suggestionState(),
      api: fakeApi({ decideSuggestion: vi.fn(() => decision.promise) }),
    });
    let transactions = 0;
    doc.on("afterTransaction", () => transactions++);
    fireEvent.click(button("Accept"));
    fireEvent.click(button("Accept")); // a double click
    expect(api.decideSuggestion).toHaveBeenCalledTimes(1);
    expect(api.decideSuggestion).toHaveBeenCalledWith(NOTEBOOK.id, SUGGESTION_ID, "accepted");
    // Nothing changes until the server has taken the decision.
    expect(source.toString()).toBe("");
    expect(transactions).toBe(0);
    await act(async () => decision.resolve(suggestion({ status: "accepted" })));
    expect(source.toString()).toBe("select count(*) from trips");
    expect(transactions).toBe(1);
    expect(screen.getByRole("status").textContent).toBe("Accepted.");
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("still applies it when the document clears the suggestion before the answer arrives", async () => {
    const decision = deferred<Suggestion>();
    const { source, setAi } = setup({
      text: "",
      ai: suggestionState(),
      api: fakeApi({ decideSuggestion: vi.fn(() => decision.promise) }),
    });
    fireEvent.click(button("Accept"));
    setAi(null); // the server's ai_resolved got here first
    await act(async () => decision.resolve(suggestion({ status: "accepted" })));
    expect(source.toString()).toBe("select count(*) from trips");
  });

  it("applies nothing if the user left the page before the answer arrived", async () => {
    const decision = deferred<Suggestion>();
    const { source } = setup({
      text: "",
      ai: suggestionState(),
      api: fakeApi({ decideSuggestion: vi.fn(() => decision.promise) }),
    });
    fireEvent.click(button("Accept"));
    cleanup();
    await act(async () => decision.resolve(suggestion({ status: "accepted" })));
    expect(source.toString()).toBe("");
  });

  it("is the accepting person's own edit: their undo reverts it in one step", async () => {
    const { source } = setup({
      text: "select 1",
      ai: suggestionState({ kind: "fix", baseSql: "select 1", sql: "select 2" }),
    });
    // Tracks local (origin null) changes, as the cell editor's UndoManager does.
    const undo = new Y.UndoManager(source);
    fireEvent.click(button("Accept"));
    await waitFor(() => expect(source.toString()).toBe("select 2"));
    act(() => {
      undo.undo();
    });
    expect(source.toString()).toBe("select 1");
  });

  it("warns before replacing SQL that changed since the AI looked at it", async () => {
    const { api, source } = setup({
      text: "select 1 -- my edit",
      ai: suggestionState({ kind: "fix", baseSql: "select 1", sql: "select 2" }),
    });
    fireEvent.click(button("Accept"));
    expect(screen.getByRole("alert").textContent).toMatch(/changed since the AI looked at it/);
    expect(source.toString()).toBe("select 1 -- my edit");
    expect(api.decideSuggestion).not.toHaveBeenCalled();

    fireEvent.click(button("Cancel"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.decideSuggestion).not.toHaveBeenCalled();

    fireEvent.click(button("Accept"));
    fireEvent.click(button("Replace anyway"));
    await waitFor(() => expect(source.toString()).toBe("select 2"));
    expect(api.decideSuggestion).toHaveBeenCalledTimes(1);
  });

  it("warns before a generated query replaces SQL already in the cell", () => {
    const { api, source } = setup({ text: "select 42", ai: suggestionState() });
    fireEvent.click(button("Accept"));
    expect(screen.getByRole("alert").textContent).toMatch(/already has SQL in it/);
    expect(source.toString()).toBe("select 42");
    expect(api.decideSuggestion).not.toHaveBeenCalled();
  });

  it("notes when an explanation is about SQL that has since changed", () => {
    setup({
      text: "select 2",
      ai: suggestionState({ kind: "explain", sql: null, baseSql: "select 1" }),
    });
    expect(screen.getByText(/changed since this was written/)).toBeTruthy();
  });

  it("rejects: records it and leaves the cell alone", async () => {
    const { api, source } = setup({ ai: suggestionState() });
    fireEvent.click(button("Reject"));
    await waitFor(() =>
      expect(api.decideSuggestion).toHaveBeenCalledWith(NOTEBOOK.id, SUGGESTION_ID, "rejected"),
    );
    expect(source.toString()).toBe("select 1");
    expect((await screen.findByRole("status")).textContent).toBe("Rejected.");
  });

  it("dismisses an explanation, which has no SQL to accept", async () => {
    const { api, source } = setup({
      ai: suggestionState({ kind: "explain", sql: null, baseSql: "select 1" }),
    });
    expect(screen.getByRole("region", { name: "AI suggestion" }).textContent).toMatch(
      /Explanation/,
    );
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    fireEvent.click(button("Dismiss"));
    await waitFor(() =>
      expect(api.decideSuggestion).toHaveBeenCalledWith(NOTEBOOK.id, SUGGESTION_ID, "rejected"),
    );
    expect(source.toString()).toBe("select 1");
  });

  it("applies nothing when the decision fails, and can be retried", async () => {
    const decideSuggestion = vi
      .fn<ApiClient["decideSuggestion"]>()
      .mockRejectedValueOnce(new ApiError(0, "network", "Could not reach the server."))
      .mockResolvedValueOnce(suggestion({ status: "accepted" }));
    const { source } = setup({
      text: "",
      ai: suggestionState(),
      api: fakeApi({ decideSuggestion }),
    });
    fireEvent.click(button("Accept"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Couldn't record your decision: Could not reach the server. Nothing was changed; try again.",
    );
    expect(source.toString()).toBe("");
    expect(button("Accept").disabled).toBe(false);

    fireEvent.click(button("Accept"));
    await waitFor(() => expect(source.toString()).toBe("select count(*) from trips"));
    expect(decideSuggestion).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    [409, "decided", "This suggestion was already accepted or rejected."],
    [404, "not_found", "This suggestion no longer exists."],
  ])("applies nothing when the API answers %i, and says why", async (status, kind, message) => {
    const { source } = setup({
      text: "",
      ai: suggestionState(),
      api: fakeApi({
        decideSuggestion: vi.fn(async () => {
          throw new ApiError(status, kind, "server text");
        }),
      }),
    });
    fireEvent.click(button("Accept"));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(source.toString()).toBe("");
    // Nothing left to decide.
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });
});

describe("two editors deciding the same suggestion at once", () => {
  /**
   * Two editors' replicas of one notebook, each with its own page. The API
   * takes one decision (200) and refuses the other (409), as the server
   * does with its single winner.
   */
  function twoEditors(text: string) {
    const docA = new Y.Doc();
    appendCell(docA, "sql", CELL);
    orderedCells(docA)[0].source!.insert(0, text);
    cellsMap(docA)
      .get(CELL)!
      .set("ai", suggestionState({ kind: "fix", baseSql: text, sql: "select 1 from trips" }));
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const refused = () => {
      throw new ApiError(409, "decided", "Already decided.");
    };
    const apiA = fakeApi(); // its decision wins
    const apiB = fakeApi({ decideSuggestion: vi.fn(async () => refused()) });
    const a = render(<Harness api={apiA} doc={docA} readOnly={false} failedRun={null} />);
    const b = render(<Harness api={apiB} doc={docB} readOnly={false} failedRun={null} />);
    const click = (view: typeof a, name: string) =>
      fireEvent.click(within(view.container).getByRole("button", { name }));
    const merge = () => {
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
    };
    const textOf = (doc: Y.Doc) => orderedCells(doc)[0].source!.toString();
    return { a, b, apiA, apiB, click, merge, docA, docB, textOf };
  }

  it("both accept: the SQL ends up in the cell exactly once", async () => {
    const { a, b, apiA, apiB, click, merge, docA, docB, textOf } = twoEditors("select nope");
    click(a, "Accept");
    click(b, "Accept");
    await waitFor(() => expect(apiA.decideSuggestion).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiB.decideSuggestion).toHaveBeenCalledTimes(1));
    await within(b.container).findByText("This suggestion was already accepted or rejected.");
    await waitFor(() => expect(textOf(docA)).toBe("select 1 from trips"));
    act(merge);
    expect(textOf(docA)).toBe("select 1 from trips");
    expect(textOf(docB)).toBe("select 1 from trips");
  });

  it("one rejects and wins, the other accepts: the cell is unchanged", async () => {
    const { a, b, apiB, click, merge, docA, docB, textOf } = twoEditors("select nope");
    click(a, "Reject");
    click(b, "Accept");
    await within(a.container).findByText("Rejected.");
    await within(b.container).findByText("This suggestion was already accepted or rejected.");
    expect(apiB.decideSuggestion).toHaveBeenCalledWith(NOTEBOOK.id, SUGGESTION_ID, "accepted");
    act(merge);
    expect(textOf(docA)).toBe("select nope");
    expect(textOf(docB)).toBe("select nope");
  });
});
