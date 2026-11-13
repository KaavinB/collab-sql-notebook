/**
 * The notebook's shared document (D1, D2).
 *
 * Everything a user edits lives in one Yjs document (Y.Doc), so Phase 2 can
 * sync it between browsers without changing this model:
 *
 *   doc.getMap("cells"): Y.Map<cellId, Y.Map>
 *     cell.get("type")      "sql" | "markdown" | "chart"
 *     cell.get("order")     fractional index string (sorts the cells)
 *     cell.get("source")    Y.Text, for sql and markdown cells
 *     cell.get("lastRunId") string | null, for sql cells (D6: results live in
 *                           Postgres; the document only points at them)
 *     cell.get("chart")     Y.Map, for chart cells: the ChartConfig (D9),
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

export interface CellView {
  id: string;
  type: CellType;
  order: string;
  /** The editable text of a sql or markdown cell; null for chart cells. */
  source: Y.Text | null;
  lastRunId: string | null;
  /** The chart's config, for chart cells; null otherwise. */
  chart: ChartConfig | null;
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
  };
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

/** Points a sql cell at its latest stored run (D6). */
export function setLastRun(doc: Y.Doc, id: string, runId: string): void {
  doc.transact(() => {
    const cell = cellsMap(doc).get(id);
    if (cell && cell.get("type") === "sql") cell.set("lastRunId", runId);
  });
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
