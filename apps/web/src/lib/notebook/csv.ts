/**
 * CSV downloads of a query result, made in the browser from the rows already
 * on screen (no extra query, no server round trip).
 *
 * Values are written raw (not display-formatted), so a spreadsheet gets real
 * numbers. Text that a spreadsheet would run as a formula (starting with =,
 * +, -, @, a tab or a carriage return) is prefixed with an apostrophe: query
 * results can hold any text, and opening a CSV shouldn't execute it.
 */
import type { QueryResult } from "@/lib/api";
import { fieldType } from "@/lib/notebook/chart";

const FORMULA_START = /^[=+\-@\t\r]/;
// What a number column's string values look like: DECIMALs and integers
// beyond 2^53 arrive as strings ("-12.50"), and so do NaN and Infinity.
const NUMBER_TEXT = /^-?(\d+(\.\d+)?(e[+-]?\d+)?|NaN|Infinity)$/i;

/**
 * One CSV field. `numeric`: the value comes from a number column, so a
 * string that is a plain number (a negative DECIMAL) is written as is, not
 * defused like text.
 */
function cell(value: unknown, numeric = false): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "string") {
    const safeNumber = numeric && NUMBER_TEXT.test(value);
    text = !safeNumber && FORMULA_START.test(value) ? `'${value}` : value;
  } else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else text = JSON.stringify(value);
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The result as RFC 4180 CSV text (CRLF line ends), header row first. */
export function resultToCsv(result: QueryResult): string {
  const numeric = result.columns.map((c) => fieldType(c.type) === "quantitative");
  const lines = [result.columns.map((c) => cell(c.name)).join(",")];
  for (const row of result.rows) lines.push(row.map((v, i) => cell(v, numeric[i])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** A safe file name from free text: letters, digits, dashes. */
export function csvFileName(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "query-result"}.csv`;
}

/** Saves the result as a CSV file through the browser's download. */
export function downloadCsv(result: QueryResult, fileName: string): void {
  // A byte-order mark makes Excel read the file as UTF-8 (zone names, etc.).
  const blob = new Blob(["﻿", resultToCsv(result)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
