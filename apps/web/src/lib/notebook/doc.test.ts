import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  appendCell,
  cellsMap,
  deleteCell,
  insertCell,
  isRunActive,
  isValidOrderKey,
  moveCell,
  orderedCells,
  MAX_AI_EXPLANATION_LENGTH,
  MAX_AI_SQL_LENGTH,
  readAi,
  readRunning,
  replaceCellText,
  setLastRun,
  setLastRunIfUnchanged,
} from "@/lib/notebook/doc";

const ids = (doc: Y.Doc) => orderedCells(doc).map((c) => c.id);

/** Delivers every update each replica has that the others lack. */
function sync(...docs: Y.Doc[]) {
  for (const from of docs) {
    for (const to of docs) {
      if (from !== to) Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
    }
  }
}

function replicaOf(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

describe("cell order", () => {
  it("starts empty", () => {
    expect(orderedCells(new Y.Doc())).toEqual([]);
  });

  it("appends, inserts at the start and inserts after a cell", () => {
    const doc = new Y.Doc();
    appendCell(doc, "sql", "a");
    appendCell(doc, "sql", "b");
    insertCell(doc, "markdown", null, "first");
    insertCell(doc, "sql", "a", "between");
    expect(ids(doc)).toEqual(["first", "a", "between", "b"]);
  });

  it("moves cells up and down, and refuses to move past the ends", () => {
    const doc = new Y.Doc();
    for (const id of ["a", "b", "c"]) appendCell(doc, "sql", id);
    expect(moveCell(doc, "c", "up")).toBe(true);
    expect(ids(doc)).toEqual(["a", "c", "b"]);
    expect(moveCell(doc, "a", "down")).toBe(true);
    expect(ids(doc)).toEqual(["c", "a", "b"]);
    expect(moveCell(doc, "c", "up")).toBe(false);
    expect(moveCell(doc, "b", "down")).toBe(false);
    expect(moveCell(doc, "missing", "up")).toBe(false);
  });

  it("deletes cells", () => {
    const doc = new Y.Doc();
    for (const id of ["a", "b"]) appendCell(doc, "sql", id);
    deleteCell(doc, "a");
    expect(ids(doc)).toEqual(["b"]);
  });

  it("breaks ties in order by cell id", () => {
    const doc = withOrders([
      ["zz", "a0"],
      ["aa", "a0"],
    ]);
    expect(ids(doc)).toEqual(["aa", "zz"]);
  });
});

/** A doc whose cells have exactly these order keys (ties allowed). */
function withOrders(cells: [id: string, order: string][]): Y.Doc {
  const doc = new Y.Doc();
  for (const [id] of cells) appendCell(doc, "sql", id);
  for (const [id, order] of cells) cellsMap(doc).get(id)!.set("order", order);
  return doc;
}

const orders = (doc: Y.Doc) => orderedCells(doc).map((c) => c.order);

describe("inserting and moving inside tied groups", () => {
  it("inserts exactly after a cell that is tied with the next one", () => {
    // What two people inserting after A at the same moment produce.
    const doc = withOrders([
      ["A", "a0"],
      ["L", "a0V"],
      ["R", "a0V"],
      ["B", "a1"],
    ]);
    insertCell(doc, "markdown", "L", "N");
    expect(ids(doc)).toEqual(["A", "L", "N", "R", "B"]);
    expect(new Set(orders(doc)).size).toBe(5); // the tie is gone
  });

  it("moves a cell up past a tied neighbour", () => {
    const doc = withOrders([
      ["X", "a0"],
      ["Y", "a0"],
      ["Z", "a2"],
    ]);
    expect(moveCell(doc, "Z", "up")).toBe(true);
    expect(ids(doc)).toEqual(["X", "Z", "Y"]);
  });

  it("moves a cell exactly one place within a tied group", () => {
    const doc = withOrders([
      ["A", "a0"],
      ["B", "a0"],
      ["C", "a0"],
      ["D", "a1"],
    ]);
    expect(moveCell(doc, "A", "down")).toBe(true);
    expect(ids(doc)).toEqual(["B", "A", "C", "D"]);
    expect(moveCell(doc, "C", "up")).toBe(true);
    expect(ids(doc)).toEqual(["B", "C", "A", "D"]);
  });

  it("inserts at the start when the first cells are tied", () => {
    const doc = withOrders([
      ["A", "a0"],
      ["B", "a0"],
    ]);
    insertCell(doc, "sql", null, "N");
    expect(ids(doc)).toEqual(["N", "A", "B"]);
    insertCell(doc, "sql", "A", "M");
    expect(ids(doc)).toEqual(["N", "A", "M", "B"]);
  });
});

describe("cell contents", () => {
  it("gives sql and markdown cells editable text, chart cells none", () => {
    const doc = new Y.Doc();
    appendCell(doc, "sql", "s");
    appendCell(doc, "markdown", "m");
    appendCell(doc, "chart", "c");
    const [s, m, c] = orderedCells(doc);
    expect(s.source).toBeInstanceOf(Y.Text);
    expect(m.source).toBeInstanceOf(Y.Text);
    expect(c.source).toBeNull();
    expect(s.lastRunId).toBeNull();
  });

  it("records the latest run only on sql cells", () => {
    const doc = new Y.Doc();
    appendCell(doc, "sql", "s");
    appendCell(doc, "markdown", "m");
    setLastRun(doc, "s", "run-1");
    setLastRun(doc, "m", "run-2");
    const [s, m] = orderedCells(doc);
    expect(s.lastRunId).toBe("run-1");
    expect(m.lastRunId).toBeNull();
  });

  it("rejects bad cell ids and unknown anchors", () => {
    const doc = new Y.Doc();
    expect(() => insertCell(doc, "sql", null, "has space")).toThrow(/invalid cell id/);
    expect(() => insertCell(doc, "sql", "nope")).toThrow(/no such cell/);
  });

  it.each(["a", "a00", "zz", "A", "a0".padEnd(65, "1"), ""])(
    "skips a cell whose order key %j is invalid, and inserting still works",
    (bad) => {
      const doc = new Y.Doc();
      appendCell(doc, "sql", "good");
      appendCell(doc, "sql", "bad");
      cellsMap(doc).get("bad")!.set("order", bad);
      expect(ids(doc)).toEqual(["good"]);
      appendCell(doc, "sql", "end");
      insertCell(doc, "sql", null, "start");
      expect(ids(doc)).toEqual(["start", "good", "end"]);
    },
  );

  it("skips malformed entries instead of crashing", () => {
    const doc = new Y.Doc();
    appendCell(doc, "sql", "good");
    const cells = cellsMap(doc);
    const badType = new Y.Map<unknown>();
    badType.set("type", "python");
    badType.set("order", "a5");
    cells.set("badType", badType);
    const badOrder = new Y.Map<unknown>();
    badOrder.set("type", "sql");
    badOrder.set("order", "../../");
    cells.set("badOrder", badOrder);
    const badId = new Y.Map<unknown>();
    badId.set("type", "sql");
    badId.set("order", "a6");
    cells.set("bad id!", badId);
    expect(ids(doc)).toEqual(["good"]);
    // And editing still works around them.
    appendCell(doc, "sql", "next");
    expect(ids(doc)).toEqual(["good", "next"]);
  });
});

describe("concurrent edits on separate replicas", () => {
  it("concurrent moves of the same cell never duplicate it", () => {
    const base = new Y.Doc();
    for (const id of ["a", "b", "c", "d"]) appendCell(base, "sql", id);
    const left = replicaOf(base);
    const right = replicaOf(base);
    moveCell(left, "b", "down");
    moveCell(right, "b", "up");
    sync(left, right);
    expect(ids(left)).toEqual(ids(right));
    expect([...ids(left)].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("concurrent inserts at the same spot keep both cells in the same order everywhere", () => {
    const base = new Y.Doc();
    for (const id of ["a", "b"]) appendCell(base, "sql", id);
    const left = replicaOf(base);
    const right = replicaOf(base);
    insertCell(left, "sql", "a", "fromLeft");
    insertCell(right, "sql", "a", "fromRight");
    sync(left, right);
    expect(ids(left)).toEqual(ids(right));
    expect(ids(left)).toHaveLength(4);
  });

  it("merges concurrent typing in the same cell", () => {
    const base = new Y.Doc();
    appendCell(base, "sql", "a");
    orderedCells(base)[0].source!.insert(0, "select 1");
    const left = replicaOf(base);
    const right = replicaOf(base);
    orderedCells(left)[0].source!.insert(0, "-- left\n");
    orderedCells(right)[0].source!.insert(8, " as one");
    sync(left, right);
    const text = orderedCells(left)[0].source!.toString();
    expect(text).toBe(orderedCells(right)[0].source!.toString());
    expect(text).toContain("-- left\n");
    expect(text).toContain(" as one");
  });

  it("random concurrent edits on three replicas converge", () => {
    // A small seeded fuzz; Phase 4 adds the full convergence test.
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
    const replicas = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
    let next = 0;
    for (let step = 0; step < 400; step++) {
      const doc = pick(replicas);
      const cells = orderedCells(doc);
      const op = random();
      if (op < 0.35 || cells.length === 0) {
        insertCell(
          doc,
          pick(["sql", "markdown", "chart"]),
          cells.length && random() < 0.8 ? pick(cells).id : null,
          `c${next++}`,
        );
      } else if (op < 0.65) {
        moveCell(doc, pick(cells).id, random() < 0.5 ? "up" : "down");
      } else if (op < 0.75) {
        deleteCell(doc, pick(cells).id);
      } else {
        const source = pick(cells).source;
        source?.insert(Math.floor(random() * (source.length + 1)), "x");
      }
      if (random() < 0.2) sync(pick(replicas), pick(replicas));
    }
    sync(...replicas);
    sync(...replicas);
    const [first, ...rest] = replicas.map((doc) =>
      orderedCells(doc).map((c) => `${c.id}:${c.type}:${c.source?.toString() ?? ""}`),
    );
    for (const other of rest) expect(other).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });
});

describe("isValidOrderKey", () => {
  it("accepts keys the library generates and rejects ones it can't use", () => {
    expect(isValidOrderKey("a0")).toBe(true);
    expect(isValidOrderKey("a0V")).toBe(true);
    for (const bad of ["", "a", "a00", "zz", "A", "a0!", "a0".padEnd(65, "1")]) {
      expect(isValidOrderKey(bad)).toBe(false);
    }
  });
});

describe("running state", () => {
  const valid = {
    executionId: "e1",
    by: "Ada",
    startedAt: "2026-11-13T10:00:00Z",
    expiresAt: "2026-11-13T10:00:27Z",
  };

  it("reads a well-formed running entry from a sql cell", () => {
    const doc = new Y.Doc();
    const id = appendCell(doc, "sql");
    cellsMap(doc).get(id)!.set("running", valid);
    expect(orderedCells(doc)[0].running).toEqual(valid);
  });

  it.each([
    ["not an object", "running"],
    ["an array", []],
    ["missing who", { ...valid, by: undefined }],
    ["a huge name", { ...valid, by: "x".repeat(201) }],
    ["a huge name in emoji", { ...valid, by: "😀".repeat(201) }],
  ])("ignores a malformed entry (%s)", (_label, value) => {
    expect(readRunning(value)).toBeNull();
  });

  it("treats an expired run as no longer running", () => {
    const running = readRunning(valid);
    expect(isRunActive(running, Date.parse("2026-11-13T10:00:26Z"))).toBe(true);
    expect(isRunActive(running, Date.parse("2026-11-13T10:00:27Z"))).toBe(false);
    expect(isRunActive(readRunning({ ...valid, expiresAt: undefined }), Date.now())).toBe(true);
    expect(isRunActive(null, Date.now())).toBe(false);
  });

  it("accepts the longest name the API allows, counted in characters", () => {
    expect(readRunning({ ...valid, by: "😀".repeat(200) })?.by).toHaveLength(400);
  });

  it("only sql cells carry it", () => {
    const doc = new Y.Doc();
    const id = appendCell(doc, "markdown");
    cellsMap(doc).get(id)!.set("running", valid);
    expect(orderedCells(doc)[0].running).toBeNull();
  });
});

describe("AI state", () => {
  const thinking = {
    status: "thinking",
    requestId: "r1",
    kind: "generate",
    by: "Ada",
    startedAt: "2026-11-13T10:00:00Z",
  };
  const suggestion = {
    status: "suggestion",
    requestId: "r1",
    suggestionId: "s1",
    kind: "fix",
    sql: "select 2",
    explanation: "Fixed.",
    baseSql: "select 1",
    valid: false,
    by: "Ada",
  };
  const failed = { status: "failed", requestId: "r1", message: "No key." };

  it("reads each state from a sql cell", () => {
    const doc = new Y.Doc();
    const id = appendCell(doc, "sql");
    for (const state of [thinking, suggestion, failed]) {
      cellsMap(doc).get(id)!.set("ai", state);
      expect(orderedCells(doc)[0].ai).toEqual(state);
    }
    cellsMap(doc).get(id)!.set("ai", null);
    expect(orderedCells(doc)[0].ai).toBeNull();
  });

  it("reads an explanation (no SQL) and a thinking state without a start time", () => {
    expect(readAi({ ...suggestion, kind: "explain", sql: null })).toMatchObject({ sql: null });
    expect(readAi({ ...thinking, startedAt: undefined })).toMatchObject({ startedAt: null });
  });

  it.each([
    ["not an object", "thinking"],
    ["an array", [thinking]],
    ["an unknown status", { ...thinking, status: "dreaming" }],
    ["no request ID", { ...thinking, requestId: undefined }],
    ["an empty request ID", { ...thinking, requestId: "" }],
    ["an unknown kind", { ...thinking, kind: "delete" }],
    ["a huge name", { ...thinking, by: "x".repeat(201) }],
    ["no suggestion ID", { ...suggestion, suggestionId: undefined }],
    ["SQL that isn't text", { ...suggestion, sql: 42 }],
    ["huge SQL", { ...suggestion, sql: "x".repeat(MAX_AI_SQL_LENGTH + 1) }],
    ["a huge base SQL", { ...suggestion, baseSql: "x".repeat(MAX_AI_SQL_LENGTH + 1) }],
    [
      "a huge explanation",
      { ...suggestion, explanation: "x".repeat(MAX_AI_EXPLANATION_LENGTH + 1) },
    ],
    ["no explanation", { ...suggestion, explanation: undefined }],
    ["a validity that isn't a boolean", { ...suggestion, valid: "yes" }],
    ["a failure without a message", { ...failed, message: undefined }],
    ["a huge failure message", { ...failed, message: "x".repeat(1001) }],
  ])("ignores a malformed entry (%s)", (_label, value) => {
    expect(readAi(value)).toBeNull();
  });

  it("only sql cells carry it", () => {
    const doc = new Y.Doc();
    const id = appendCell(doc, "markdown");
    cellsMap(doc).get(id)!.set("ai", thinking);
    expect(orderedCells(doc)[0].ai).toBeNull();
  });
});

describe("replaceCellText", () => {
  function sqlCell(text: string) {
    const doc = new Y.Doc();
    const id = appendCell(doc, "sql");
    const source = orderedCells(doc)[0].source!;
    source.insert(0, text);
    return { doc, id, source };
  }

  it("replaces the whole text in one transaction, which one undo reverts", () => {
    const { doc, id, source } = sqlCell("select 1");
    const undo = new Y.UndoManager(source);
    let transactions = 0;
    doc.on("afterTransaction", () => transactions++);
    expect(replaceCellText(doc, id, "select count(*) from trips")).toBe(true);
    expect(source.toString()).toBe("select count(*) from trips");
    expect(transactions).toBe(1);
    undo.undo();
    expect(source.toString()).toBe("select 1");
  });

  it("does nothing when the text already is the suggestion, or the cell is gone", () => {
    const { doc, id } = sqlCell("select 2");
    let transactions = 0;
    doc.on("update", () => transactions++);
    expect(replaceCellText(doc, id, "select 2")).toBe(false);
    expect(replaceCellText(doc, "missing", "select 2")).toBe(false);
    expect(transactions).toBe(0);
  });
});

describe("setLastRunIfUnchanged", () => {
  it("re-points the cell only if nobody else did meanwhile", () => {
    const doc = new Y.Doc();
    const id = appendCell(doc, "sql");
    expect(setLastRunIfUnchanged(doc, id, null, "r1")).toBe(true);
    // A newer run landed while ours was in flight: ours must not replace it.
    setLastRun(doc, id, "r2");
    expect(setLastRunIfUnchanged(doc, id, "r1", "r1-late")).toBe(false);
    expect(orderedCells(doc)[0].lastRunId).toBe("r2");
    expect(setLastRunIfUnchanged(doc, id, "r2", "r3")).toBe(true);
    expect(orderedCells(doc)[0].lastRunId).toBe("r3");
  });

  it("ignores missing and non-sql cells", () => {
    const doc = new Y.Doc();
    const md = appendCell(doc, "markdown");
    expect(setLastRunIfUnchanged(doc, md, null, "r1")).toBe(false);
    expect(setLastRunIfUnchanged(doc, "gone", null, "r1")).toBe(false);
  });
});
