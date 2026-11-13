/**
 * The AI assistant as a collaborator in the document.
 *
 * The AI runs in the API. It never edits a cell's text: it reports what it's
 * doing through NOTIFY events, and this server mirrors that into the cell's
 * `ai` field (a plain JSON value, written in server-origin transactions like
 * `running`), so every member sees it live:
 *
 *   { status: "thinking", requestId, kind, by, startedAt }
 *   { status: "suggestion", requestId, suggestionId, kind, sql, explanation,
 *     baseSql, valid, by }
 *   { status: "failed", requestId, message }
 *   null (no AI activity, or the suggestion was accepted or rejected)
 *
 * People accept a suggestion by telling the API first; only once it has
 * recorded the decision does the accepting person replace the cell's text
 * (their own edit, which their undo can revert). Deciding first means two
 * people accepting at once can't both apply it.
 *
 * While some cell's AI state is thinking or suggestion, the room also shows
 * the AI as present: one awareness entry the server owns, under a client ID
 * no connection may announce (see RoomAwareness), with its own name and
 * color and a cursor at the end of that cell's text.
 */
import * as Y from "yjs";

import { isCursor } from "./awareness.ts";
import type { AiKind } from "./notify.ts";
import type { StoredSuggestion } from "./store.ts";

/**
 * The awareness client ID reserved for the AI. Browsers pick theirs at
 * random from all 2^32 values, so a tab could draw this one by chance (about
 * one in four billion): its presence would then not be relayed, nothing
 * worse. Not 0, in case some client code treats the ID as a truthy value.
 */
export const AI_CLIENT_ID = 1;

/** The AI's identity in the presence list. Real users' IDs are UUIDs, so this can't collide. */
export const AI_USER = { id: "ai-assistant", name: "AI assistant", color: "#7c3aed" } as const;

/**
 * Caps on what goes into the document, in UTF-16 units (the API bounds
 * these much lower; this only stops a broken row from bloating every
 * member's copy of the document). The web app accepts the same sizes.
 */
export const MAX_AI_SQL_LENGTH = 100_000;
export const MAX_AI_EXPLANATION_LENGTH = 10_000;

export const STOPPED_MESSAGE = "The AI assistant stopped before answering.";
const TOO_LARGE_MESSAGE = "The AI assistant's answer was too large to show.";

export interface AiThinking {
  status: "thinking";
  requestId: string;
  kind: AiKind;
  by: string;
  startedAt: string;
}

export interface AiSuggestion {
  status: "suggestion";
  requestId: string;
  suggestionId: string;
  kind: AiKind;
  sql: string | null;
  explanation: string;
  baseSql: string | null;
  valid: boolean;
  by: string;
}

export interface AiFailed {
  status: "failed";
  requestId: string;
  message: string;
}

export type AiState = AiThinking | AiSuggestion | AiFailed;

/** What the server needs to know about a cell's current `ai` value. */
export interface AiRef {
  status: AiState["status"];
  requestId: string;
  suggestionId: string | null;
}

const STATUSES: ReadonlySet<string> = new Set(["thinking", "suggestion", "failed"]);
const MAX_ID_LENGTH = 128;

/**
 * Reads a cell's `ai` value just enough to reconcile it. Editors can write
 * anything into the document, so a malformed value reads as null (no AI
 * state) and is left alone.
 */
export function readAiRef(value: unknown): AiRef | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { status, requestId, suggestionId } = value as Record<string, unknown>;
  if (typeof status !== "string" || !STATUSES.has(status)) return null;
  if (typeof requestId !== "string" || requestId.length > MAX_ID_LENGTH) return null;
  const suggestion =
    typeof suggestionId === "string" && suggestionId.length <= MAX_ID_LENGTH ? suggestionId : null;
  if (status === "suggestion" && suggestion === null) return null;
  return { status: status as AiRef["status"], requestId, suggestionId: suggestion };
}

/**
 * The document value for a stored suggestion, or a failure if it's too big
 * to put in the document. `fallbackBy` names the asker when their account is
 * gone (from the thinking state the cell showed, if any).
 */
export function suggestionState(row: StoredSuggestion, fallbackBy = ""): AiSuggestion | AiFailed {
  if (
    (row.sql?.length ?? 0) > MAX_AI_SQL_LENGTH ||
    (row.baseSql?.length ?? 0) > MAX_AI_SQL_LENGTH ||
    row.explanation.length > MAX_AI_EXPLANATION_LENGTH
  ) {
    return { status: "failed", requestId: row.requestId, message: TOO_LARGE_MESSAGE };
  }
  return {
    status: "suggestion",
    requestId: row.requestId,
    suggestionId: row.id,
    kind: row.kind,
    sql: row.sql,
    explanation: row.explanation,
    baseSql: row.baseSql,
    valid: row.valid,
    by: row.by ?? fallbackBy,
  };
}

/**
 * A cursor at the end of `text`, in exactly the form y-codemirror sends
 * (JSON of a RelativePosition into nested text), so browsers draw it in that
 * cell's editor. "End" is the type itself with no item, which stays at the
 * end as the text grows or is replaced. Null if the text isn't nested in the
 * document (it always is for a cell's source).
 */
export function cursorAtEnd(text: Y.Text): unknown {
  const position = Y.createRelativePositionFromTypeIndex(text, text.length);
  const cursor = {
    anchor: JSON.parse(JSON.stringify(position)) as unknown,
    head: JSON.parse(JSON.stringify(position)) as unknown,
  };
  return isCursor(cursor) ? cursor : null;
}

/**
 * The AI's awareness state for the document, or null if no cell is waiting
 * on it. When several cells are, the cursor goes to `preferred` (the cell
 * the AI acted on last) if it's one of them, else to a cell it's thinking
 * about, else to one with a suggestion; ties go to the smallest cell ID, so
 * the choice doesn't depend on map iteration order.
 */
export function aiPresence(
  cells: Y.Map<unknown>,
  preferred: string | null,
): Record<string, unknown> | null {
  const waiting: Array<{
    cellId: string;
    status: "thinking" | "suggestion";
    cell: Y.Map<unknown>;
  }> = [];
  cells.forEach((cell, cellId) => {
    if (!(cell instanceof Y.Map) || cell.get("type") !== "sql") return;
    const ref = readAiRef(cell.get("ai"));
    if (ref && (ref.status === "thinking" || ref.status === "suggestion")) {
      waiting.push({ cellId, status: ref.status, cell });
    }
  });
  if (waiting.length === 0) return null;
  waiting.sort(
    (a, b) =>
      Number(b.cellId === preferred) - Number(a.cellId === preferred) ||
      Number(b.status === "thinking") - Number(a.status === "thinking") ||
      (a.cellId < b.cellId ? -1 : a.cellId > b.cellId ? 1 : 0),
  );
  const { cellId, status, cell } = waiting[0]!;
  const source = cell.get("source");
  return {
    user: { ...AI_USER },
    cursor: source instanceof Y.Text ? cursorAtEnd(source) : null,
    ai: { cellId, status },
  };
}
