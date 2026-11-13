/** Pure units for the AI collaborator: its events, its presence entry and its cursor. */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  AI_CLIENT_ID,
  AI_USER,
  aiPresence,
  cursorAtEnd,
  MAX_AI_SQL_LENGTH,
  readAiRef,
  suggestionState,
} from "../src/ai.ts";
import {
  isCursor,
  OUTDATED_TIMEOUT_MS,
  RoomAwareness,
  SERVER_RENEW_MS,
  type AwarenessUser,
} from "../src/awareness.ts";
import { parseEvent } from "../src/notify.ts";
import type { StoredSuggestion } from "../src/store.ts";
import { cellOf, docWithSqlCell } from "./helpers.ts";

const NB = "4e7cec47-ee07-48e8-b7cd-3b878e00aa86";
const REQ = "0b0f3c50-61c4-4b2a-9d39-5d1f2a7f3e10";
const SUG = "2b1f8a52-8a8e-4f43-9e0e-5d2f7f0c1a11";

function update(entries: Array<[number, number, unknown]>): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const [id, clock, state] of entries) {
    encoding.writeVarUint(encoder, id);
    encoding.writeVarUint(encoder, clock);
    encoding.writeVarString(encoder, JSON.stringify(state));
  }
  return encoding.toUint8Array(encoder);
}

function decode(bytes: Uint8Array | null): Array<[number, number, unknown]> {
  if (!bytes) return [];
  const decoder = decoding.createDecoder(bytes);
  const count = decoding.readVarUint(decoder);
  const entries: Array<[number, number, unknown]> = [];
  for (let i = 0; i < count; i++) {
    entries.push([
      decoding.readVarUint(decoder),
      decoding.readVarUint(decoder),
      JSON.parse(decoding.readVarString(decoder)),
    ]);
  }
  return entries;
}

describe("AI events", () => {
  const parse = (event: Record<string, unknown>) => parseEvent(JSON.stringify(event));

  it("parses each of the four", () => {
    expect(
      parse({
        type: "ai_started",
        notebook_id: NB,
        cell_id: "c1",
        request_id: REQ,
        kind: "fix",
        user_name: "Ada",
      }),
    ).toEqual({
      type: "ai_started",
      notebookId: NB,
      cellId: "c1",
      requestId: REQ,
      kind: "fix",
      userName: "Ada",
    });
    expect(
      parse({
        type: "ai_suggestion",
        notebook_id: NB,
        cell_id: "c1",
        request_id: REQ.toUpperCase(),
        suggestion_id: SUG,
      }),
    ).toEqual({
      type: "ai_suggestion",
      notebookId: NB,
      cellId: "c1",
      requestId: REQ, // normalized
      suggestionId: SUG,
    });
    expect(
      parse({
        type: "ai_failed",
        notebook_id: NB,
        cell_id: "c1",
        request_id: REQ,
        message: "x".repeat(300),
      }),
    ).toMatchObject({ type: "ai_failed", message: "x".repeat(300) });
    expect(
      parse({
        type: "ai_resolved",
        notebook_id: NB,
        cell_id: "c1",
        suggestion_id: SUG,
        decision: "rejected",
      }),
    ).toEqual({
      type: "ai_resolved",
      notebookId: NB,
      cellId: "c1",
      suggestionId: SUG,
      decision: "rejected",
    });
  });

  it.each([
    ["an unknown kind", { type: "ai_started", kind: "delete", user_name: "Ada" }],
    ["a missing user name", { type: "ai_started", kind: "generate" }],
    ["an overlong user name", { type: "ai_started", kind: "generate", user_name: "a".repeat(201) }],
    ["a bad request ID", { type: "ai_failed", request_id: "1; drop", message: "x" }],
    ["an overlong message", { type: "ai_failed", message: "x".repeat(301) }],
    ["a non-string message", { type: "ai_failed", message: 5 }],
    ["a bad suggestion ID", { type: "ai_suggestion", suggestion_id: "abc" }],
    ["an unknown decision", { type: "ai_resolved", suggestion_id: SUG, decision: "maybe" }],
    [
      "a bad cell ID",
      { type: "ai_resolved", suggestion_id: SUG, decision: "accepted", cell_id: "a b" },
    ],
  ])("rejects %s", (_why, fields) => {
    expect(parse({ notebook_id: NB, cell_id: "c1", request_id: REQ, ...fields })).toBeNull();
  });
});

describe("readAiRef", () => {
  it("reads the three states and nothing malformed", () => {
    expect(readAiRef({ status: "thinking", requestId: REQ })).toEqual({
      status: "thinking",
      requestId: REQ,
      suggestionId: null,
    });
    expect(readAiRef({ status: "suggestion", requestId: REQ, suggestionId: SUG })).toMatchObject({
      suggestionId: SUG,
    });
    for (const bad of [
      null,
      "thinking",
      [],
      { status: "dreaming", requestId: REQ },
      { status: "thinking" },
      { status: "thinking", requestId: "x".repeat(129) },
      { status: "suggestion", requestId: REQ }, // no suggestion ID
    ]) {
      expect(readAiRef(bad)).toBeNull();
    }
  });
});

describe("suggestionState", () => {
  const row: StoredSuggestion = {
    id: SUG,
    cellId: "c1",
    requestId: REQ,
    kind: "fix",
    status: "pending",
    sql: "select 2",
    explanation: "Fixed it.",
    baseSql: "select 1",
    valid: true,
    by: null,
  };

  it("names the asker from the thinking state when their account is gone", () => {
    expect(suggestionState(row, "Ada")).toEqual({
      status: "suggestion",
      requestId: REQ,
      suggestionId: SUG,
      kind: "fix",
      sql: "select 2",
      explanation: "Fixed it.",
      baseSql: "select 1",
      valid: true,
      by: "Ada",
    });
    expect(suggestionState({ ...row, by: "Grace" }, "Ada")).toMatchObject({ by: "Grace" });
  });

  it("turns an answer too large for the document into a failure", () => {
    expect(suggestionState({ ...row, sql: "x".repeat(MAX_AI_SQL_LENGTH + 1) })).toMatchObject({
      status: "failed",
      requestId: REQ,
    });
  });
});

describe("the AI's presence", () => {
  it("puts its cursor at the end of the cell's text, in the form clients accept", () => {
    const doc = docWithSqlCell("c1", "select 1");
    const text = cellOf(doc, "c1")!.get("source") as Y.Text;
    const cursor = cursorAtEnd(text) as { anchor: unknown; head: unknown };
    expect(isCursor(cursor)).toBe(true);
    // Exactly what y-codemirror would send: all four keys, the type's ID, no item.
    expect(Object.keys(cursor.anchor as object).sort()).toEqual(["assoc", "item", "tname", "type"]);
    const resolve = () =>
      Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(cursor.head),
        doc,
      );
    expect(resolve()).toMatchObject({ type: text, index: 8 });
    // It stays at the end as the text changes.
    text.insert(8, " + 1");
    expect(resolve()!.index).toBe(12);
  });

  it("follows the cell the AI acted on last, then thinking before suggestions", () => {
    const doc = new Y.Doc();
    for (const [id, status] of [
      ["b", "suggestion"],
      ["c", "thinking"],
      ["a", "suggestion"],
      ["d", "failed"],
    ] as const) {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(docWithSqlCell(id)));
      cellOf(doc, id)!.set("ai", { status, requestId: REQ, suggestionId: SUG });
    }
    const cells = doc.getMap<unknown>("cells");
    expect(aiPresence(cells, null)).toMatchObject({
      user: AI_USER,
      ai: { cellId: "c", status: "thinking" },
    });
    expect(aiPresence(cells, "b")).toMatchObject({ ai: { cellId: "b", status: "suggestion" } });
    expect(aiPresence(cells, "d")).toMatchObject({ ai: { cellId: "c" } }); // failed doesn't count
    cellOf(doc, "c")!.set("ai", null);
    expect(aiPresence(cells, null)).toMatchObject({ ai: { cellId: "a" } });
    cellOf(doc, "a")!.set("ai", null);
    cellOf(doc, "b")!.set("ai", { status: "thinking" }); // malformed: ignored
    expect(aiPresence(cells, null)).toBeNull();
  });
});

describe("server-owned awareness entries", () => {
  const ALICE: AwarenessUser = { id: "a", name: "Alice", color: "#111111" };

  function setup() {
    let now = 1_000_000;
    const awareness = new RoomAwareness<string>(() => now, [AI_CLIENT_ID]);
    return { awareness, advance: (ms: number) => (now += ms) };
  }

  it("can't be claimed by any connection, even as its first announcement", () => {
    const { awareness } = setup();
    const claim = awareness.apply("viewer", ALICE, update([[AI_CLIENT_ID, 9, { x: "fake AI" }]]));
    expect(claim.forPeers).toBeNull();
    // The connection can still announce its own ID afterwards.
    expect(awareness.apply("viewer", ALICE, update([[7, 0, { x: 1 }]])).forPeers).not.toBeNull();
    awareness.setServerState(AI_CLIENT_ID, { user: AI_USER });
    // A client relaying (or forging) the AI's entry changes nothing.
    awareness.apply("viewer", ALICE, update([[AI_CLIENT_ID, 2 ** 40, { user: ALICE }]]));
    expect(awareness.states().get(AI_CLIENT_ID)).toEqual({ user: AI_USER });
  });

  it("refuses an ID that isn't reserved", () => {
    expect(() => setup().awareness.setServerState(42, { x: 1 })).toThrow();
  });

  it("announces changes only, removes, and lists the entry for joiners", () => {
    const { awareness } = setup();
    const first = decode(awareness.setServerState(AI_CLIENT_ID, { user: AI_USER, n: 1 }));
    expect(first).toEqual([[AI_CLIENT_ID, expect.any(Number), { user: AI_USER, n: 1 }]]);
    expect(awareness.setServerState(AI_CLIENT_ID, { user: AI_USER, n: 1 })).toBeNull();
    const joined = decode(awareness.encodeAll("someone", "x"));
    expect(joined.map(([id]) => id)).toEqual([AI_CLIENT_ID]);
    expect(joined[0]![1]).toBeGreaterThan(first[0]![1]);
    const removal = decode(awareness.setServerState(AI_CLIENT_ID, null));
    expect(removal).toEqual([[AI_CLIENT_ID, expect.any(Number), null]]);
    expect(removal[0]![1]).toBeGreaterThan(joined[0]![1]);
    expect(awareness.setServerState(AI_CLIENT_ID, null)).toBeNull();
    expect(awareness.encodeAll("someone", "x")).toBeNull();
  });

  it("renews it before clients would drop it as silent, and never sweeps it", () => {
    const { awareness, advance } = setup();
    awareness.setServerState(AI_CLIENT_ID, { user: AI_USER });
    expect(SERVER_RENEW_MS).toBeLessThan(OUTDATED_TIMEOUT_MS);
    advance(SERVER_RENEW_MS - 1);
    expect(awareness.renewServerStates()).toBeNull();
    advance(1);
    const renewal = decode(awareness.renewServerStates());
    expect(renewal).toEqual([[AI_CLIENT_ID, expect.any(Number), { user: AI_USER }]]);
    expect(awareness.renewServerStates()).toBeNull(); // not due again yet
    advance(OUTDATED_TIMEOUT_MS * 2);
    expect(awareness.sweep()).toEqual([]);
    expect(awareness.states().has(AI_CLIENT_ID)).toBe(true);
  });
});
