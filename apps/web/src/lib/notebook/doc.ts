/**
 * The notebook's shared Yjs document, ordered with fractional indexes.
 *
 * Everything a user edits lives in one Yjs document (Y.Doc), so Phase 2 can
 * sync it between browsers without changing this model:
 *
 *   doc.getMap("cells"): Y.Map<cellId, Y.Map>
 *     cell.get("type")      "sql" | "markdown" | "chart"
 *     cell.get("order")     fractional index string (sorts the cells)
 *     cell.get("source")    Y.Text, for sql and markdown cells
 *     cell.get("lastRunId") string | null, for sql cells (results live in
 *                           Postgres; the document only points at them)
 *     cell.get("running")   { executionId, by, startedAt, expiresAt } | null,
 *                           for sql cells: a run in progress, written by the
 *                           sync server when the API reports a run starting
 *                           and finishing, so everyone sees it. Nothing stops
 *                           an editor's own client writing it too (editors
 *                           can change anything in the document), so it's a
 *                           display hint, not proof of who ran what.
 *     cell.get("ai")        AiState | null, for sql cells: what the AI
 *                           assistant is doing for the cell (thinking, a
 *                           suggestion waiting for a decision, or a
 *                           failure), written by the sync server from the
 *                           API's events. Like `running`, editors could
 *                           write it too, so it's read defensively and a
 *                           suggestion is only decided through the API.
 *     cell.get("chart")    Y.Map, for chart cells: the ChartConfig,
 *                           one entry per field (see chart.ts)
 *
 * Why a map plus an `order` string, not a Y.Array of cells: Yjs arrays have no
 * "move". A move is delete + insert, so two people moving the same cell at
 * once would duplicate it. Here a move rewrites one `order` field, and
 * concurrent moves resolve last-writer-wins without duplicates.
 *
 * Ties: two people inserting at the same spot at the same time generate the
 * same `order` key. The cell ID breaks the tie for sorting, so every replica
 * shows the same order. But no key exists strictly between two equal keys, so
 * when an insert or move lands inside a tied group, that group is given fresh
 * distinct keys in the same transaction (see planKeys).
 */
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import * as Y from "yjs";

import { newChartMap, readChartConfig, type ChartConfig } from "@/lib/notebook/chart";

export const CELL_TYPES = ["sql", "markdown", "chart"] as const;
export type CellType = (typeof CELL_TYPES)[number];

/** A run in progress on a sql cell, as the sync server recorded it. */
export interface RunningState {
  executionId: string;
  /** Display name of whoever pressed Run. */
  by: string;
  /** ISO-8601 times. After `expiresAt` the run's lock has expired, so it isn't running anymore. */
  startedAt: string;
  expiresAt: string | null;
}

export const AI_KINDS = ["generate", "fix", "explain"] as const;
export type AiKind = (typeof AI_KINDS)[number];

/** The AI assistant's state on a sql cell, as the sync server recorded it. */
export type AiState =
  | {
      status: "thinking";
      requestId: string;
      kind: AiKind;
      /** Display name of whoever asked. */
      by: string;
      startedAt: string | null;
    }
  | {
      status: "suggestion";
      requestId: string;
      suggestionId: string;
      kind: AiKind;
      /** The suggested SQL; null for an explanation. */
      sql: string | null;
      explanation: string;
      /** The cell's SQL the request was about (fix, explain); null for generate. */
      baseSql: string | null;
      /** Whether the suggested SQL passed validation (parse and plan) on the database. */
      valid: boolean;
      by: string;
    }
  | { status: "failed"; requestId: string; message: string };

export interface CellView {
  id: string;
  type: CellType;
  order: string;
  /** The editable text of a sql or markdown cell; null for chart cells. */
  source: Y.Text | null;
  lastRunId: string | null;
  /** The chart's config, for chart cells; null otherwise. */
  chart: ChartConfig | null;
  /** A run in progress, for sql cells; null otherwise. */
  running: RunningState | null;
  /** The AI assistant's state, for sql cells; null otherwise or when there is none. */
  ai: AiState | null;
}

const CELLS_KEY = "cells";
// Real keys stay short (a few characters, growing slowly with repeated
// inserts at one spot); the cap stops a peer from planting a huge one.
const MAX_ORDER_KEY_LENGTH = 64;
// The library's base-62 alphabet. Checked separately: the library validates a
// key's structure but not every character in it (it accepts "a0!").
const ORDER_KEY_ALPHABET = /^[0-9A-Za-z]+$/;
// The API only accepts cell IDs like this (see notebooks/routes.py).
const CELL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function cellsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(CELLS_KEY);
}

/** Plain code-unit comparison, which is what fractional indexing is designed for. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCells(a: CellView, b: CellView): number {
  return compareKeys(a.order, b.order) || compareKeys(a.id, b.id);
}

/**
 * Whether `key` is a valid fractional-indexing key. One invalid key used as a
 * bound makes every later insert throw, so this checks both the alphabet and
 * the library's own structural rules ("a", "a00", "zz" and "A" use only valid
 * characters but are still invalid keys).
 */
export function isValidOrderKey(key: string): boolean {
  if (key.length > MAX_ORDER_KEY_LENGTH || !ORDER_KEY_ALPHABET.test(key)) return false;
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads one cell defensively. In Phase 2 other browsers write to this
 * document, so a malformed entry (bad type, bad order key) must not crash
 * the notebook; it is skipped instead.
 */
function readCell(id: string, cell: unknown): CellView | null {
  if (!(cell instanceof Y.Map) || !CELL_ID_PATTERN.test(id)) return null;
  const type = cell.get("type");
  const order = cell.get("order");
  if (!CELL_TYPES.includes(type as CellType)) return null;
  if (typeof order !== "string" || !isValidOrderKey(order)) return null;
  const source = cell.get("source");
  const lastRunId = cell.get("lastRunId");
  return {
    id,
    type: type as CellType,
    order,
    source: source instanceof Y.Text ? source : null,
    lastRunId: typeof lastRunId === "string" ? lastRunId : null,
    chart: type === "chart" ? readChartConfig(cell.get("chart")) : null,
    running: type === "sql" ? readRunning(cell.get("running")) : null,
    ai: type === "sql" ? readAi(cell.get("ai")) : null,
  };
}

// The API's limit for a user's name (users.name), in characters (code
// points, not UTF-16 units: one emoji is one character there, two units here).
const MAX_RUNNING_TEXT = 200;
const shortString = (value: unknown): value is string =>
  typeof value === "string" && [...value].length <= MAX_RUNNING_TEXT;

/** Reads a cell's `running` entry, or null if it's absent or malformed. */
export function readRunning(value: unknown): RunningState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { executionId, by, startedAt, expiresAt } = value as Record<string, unknown>;
  if (!shortString(executionId) || !shortString(by) || !shortString(startedAt)) return null;
  return {
    executionId,
    by,
    startedAt,
    expiresAt: shortString(expiresAt) ? expiresAt : null,
  };
}

// Same caps as the sync server applies before writing a suggestion (UTF-16
// units). The API keeps these far smaller; anything bigger is malformed.
export const MAX_AI_SQL_LENGTH = 100_000;
export const MAX_AI_EXPLANATION_LENGTH = 10_000;
// The server's own failure messages, and the API's (at most 300 characters).
const MAX_AI_MESSAGE_LENGTH = 1_000;

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
const sqlOrNull = (value: unknown): value is string | null =>
  value === null || boundedString(value, MAX_AI_SQL_LENGTH);

/**
 * Reads a cell's `ai` entry, or null if it's absent or malformed. Every field
 * is checked, because the UI shows them and acts on them (Accept writes the
 * suggested SQL into the cell).
 */
export function readAi(value: unknown): AiState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!shortString(v.requestId) || !v.requestId) return null;
  switch (v.status) {
    case "thinking":
      if (!AI_KINDS.includes(v.kind as AiKind) || !shortString(v.by)) return null;
      return {
        status: "thinking",
        requestId: v.requestId,
        kind: v.kind as AiKind,
        by: v.by,
        startedAt: shortString(v.startedAt) ? v.startedAt : null,
      };
    case "suggestion":
      if (
        !shortString(v.suggestionId) ||
        !v.suggestionId ||
        !AI_KINDS.includes(v.kind as AiKind) ||
        !sqlOrNull(v.sql) ||
        !sqlOrNull(v.baseSql) ||
        !boundedString(v.explanation, MAX_AI_EXPLANATION_LENGTH) ||
        typeof v.valid !== "boolean" ||
        !shortString(v.by)
      ) {
        return null;
      }
      return {
        status: "suggestion",
        requestId: v.requestId,
        suggestionId: v.suggestionId,
        kind: v.kind as AiKind,
        sql: v.sql,
        explanation: v.explanation,
        baseSql: v.baseSql,
        valid: v.valid,
        by: v.by,
      };
    case "failed":
      if (!boundedString(v.message, MAX_AI_MESSAGE_LENGTH)) return null;
      return { status: "failed", requestId: v.requestId, message: v.message };
    default:
      return null;
  }
}

/**
 * Accepting a suggestion: replaces the cell's whole text with `sql` in one
 * transaction made by this client, so it's the accepting person's own edit
 * (their editor's undo reverts it in one step) and collaborators see one
 * change. Does nothing if the text already is `sql` (someone accepted it
 * first). Returns whether it changed the text.
 */
export function replaceCellText(doc: Y.Doc, id: string, sql: string): boolean {
  let changed = false;
  doc.transact(() => {
    const cell = cellsMap(doc).get(id);
    const source = cell?.get("source");
    if (!cell || cell.get("type") !== "sql" || !(source instanceof Y.Text)) return;
    if (source.toString() === sql) return;
    source.delete(0, source.length);
    source.insert(0, sql);
    changed = true;
  });
  return changed;
}

/** Whether a run is still in progress at `now` (ms since epoch). */
export function isRunActive(running: RunningState | null, now: number): boolean {
  if (!running) return false;
  if (running.expiresAt === null) return true;
  const expires = Date.parse(running.expiresAt);
  return Number.isNaN(expires) || now < expires;
}

/** All valid cells, in display order. */
export function orderedCells(doc: Y.Doc): CellView[] {
  const cells: CellView[] = [];
  cellsMap(doc).forEach((cell, id) => {
    const view = readCell(id, cell);
    if (view) cells.push(view);
  });
  return cells.sort(compareCells);
}

interface KeyPlan {
  /** The key for the cell being placed. */
  key: string;
  /** Cells in a tied group that need new keys, by cell id. */
  rekey: Map<string, string>;
}

/**
 * Plans a key for a cell placed at `index` in `cells` (sorted, not containing
 * the cell being placed): after cells[index - 1] and before cells[index].
 *
 * If those two neighbours have different keys, a key between them is enough.
 * If they share a key (a tie), no key fits between them, so the whole tied
 * group plus the new cell get fresh keys between the nearest distinct keys
 * around the group, keeping the group's current order.
 */
function planKeys(cells: CellView[], index: number): KeyPlan {
  const lower = index > 0 ? cells[index - 1].order : null;
  const upper = index < cells.length ? cells[index].order : null;
  if (lower === null || upper === null || lower !== upper) {
    return { key: generateKeyBetween(lower, upper), rekey: new Map() };
  }
  let start = index - 1;
  while (start > 0 && cells[start - 1].order === lower) start--;
  let end = index; // exclusive
  while (end < cells.length && cells[end].order === lower) end++;
  const below = start > 0 ? cells[start - 1].order : null;
  const above = end < cells.length ? cells[end].order : null;
  const keys = generateNKeysBetween(below, above, end - start + 1);
  const rekey = new Map<string, string>();
  let k = 0;
  for (let i = start; i < index; i++) rekey.set(cells[i].id, keys[k++]);
  const key = keys[k++];
  for (let i = index; i < end; i++) rekey.set(cells[i].id, keys[k++]);
  return { key, rekey };
}

function applyRekey(doc: Y.Doc, rekey: Map<string, string>): void {
  const cells = cellsMap(doc);
  rekey.forEach((order, id) => cells.get(id)?.set("order", order));
}

/**
 * A new random cell ID. crypto.randomUUID only exists in secure contexts
 * (HTTPS or localhost), which is how the app is served; opening the dev
 * server over plain HTTP on a LAN address would make this throw.
 */
export function newCellId(): string {
  return crypto.randomUUID();
}

/**
 * Inserts a new cell after the cell `afterId`, or at the start when it's
 * null, and returns the new cell's ID.
 */
export function insertCell(
  doc: Y.Doc,
  type: CellType,
  afterId: string | null,
  id: string = newCellId(),
): string {
  if (!CELL_ID_PATTERN.test(id)) throw new Error(`invalid cell id: ${id}`);
  const cells = orderedCells(doc);
  let index = 0;
  if (afterId !== null) {
    const after = cells.findIndex((c) => c.id === afterId);
    if (after === -1) throw new Error(`no such cell: ${afterId}`);
    index = after + 1;
  }
  const plan = planKeys(cells, index);
  doc.transact(() => {
    applyRekey(doc, plan.rekey);
    const cell = new Y.Map<unknown>();
    cell.set("type", type);
    cell.set("order", plan.key);
    if (type !== "chart") cell.set("source", new Y.Text());
    if (type === "sql") cell.set("lastRunId", null);
    if (type === "chart") cell.set("chart", newChartMap());
    cellsMap(doc).set(id, cell);
  });
  return id;
}

/** Appends a cell at the end and returns its ID. */
export function appendCell(doc: Y.Doc, type: CellType, id?: string): string {
  const cells = orderedCells(doc);
  return insertCell(doc, type, cells.length ? cells[cells.length - 1].id : null, id);
}

/** Moves a cell one place up or down. Returns false if it can't move. */
export function moveCell(doc: Y.Doc, id: string, direction: "up" | "down"): boolean {
  const cells = orderedCells(doc);
  const from = cells.findIndex((c) => c.id === id);
  if (from === -1) return false;
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= cells.length) return false;
  // Plan the new position among the other cells, then slot it in.
  const others = cells.filter((c) => c.id !== id);
  const plan = planKeys(others, to);
  doc.transact(() => {
    applyRekey(doc, plan.rekey);
    cellsMap(doc).get(id)?.set("order", plan.key);
  });
  return true;
}

export function deleteCell(doc: Y.Doc, id: string): void {
  doc.transact(() => {
    cellsMap(doc).delete(id);
  });
}

/** Points a sql cell at its latest stored run in Postgres. */
export function setLastRun(doc: Y.Doc, id: string, runId: string): void {
  doc.transact(() => {
    const cell = cellsMap(doc).get(id);
    if (cell && cell.get("type") === "sql") cell.set("lastRunId", runId);
  });
}

/**
 * Points a sql cell at `runId` only if it still points at `expected` (what
 * it showed when Run was pressed). If the pointer moved meanwhile, someone's
 * newer run (or the sync server announcing this same run) got there first,
 * and a late response must not move the cell back to an older result.
 * Returns whether it changed the pointer.
 */
export function setLastRunIfUnchanged(
  doc: Y.Doc,
  id: string,
  expected: string | null,
  runId: string,
): boolean {
  let changed = false;
  doc.transact(() => {
    const cell = cellsMap(doc).get(id);
    if (!cell || cell.get("type") !== "sql") return;
    const current = cell.get("lastRunId");
    if ((typeof current === "string" ? current : null) !== expected) return;
    cell.set("lastRunId", runId);
    changed = true;
  });
  return changed;
}

/** The chart config map of a chart cell, created if a peer left it out. */
export function chartMap(doc: Y.Doc, id: string): Y.Map<unknown> | null {
  const cell = cellsMap(doc).get(id);
  if (!cell || cell.get("type") !== "chart") return null;
  const existing = cell.get("chart");
  if (existing instanceof Y.Map) return existing;
  const created = newChartMap();
  doc.transact(() => cell.set("chart", created));
  return created;
}
