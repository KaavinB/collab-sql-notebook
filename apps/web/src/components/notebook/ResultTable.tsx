import { memo } from "react";

import type { QueryResult } from "@/lib/api";

/** One result value as text. React escapes it, so values can't inject markup. */
export function formatValue(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Memoized: a result can be thousands of cells, and each run's result object
 * keeps its identity in the runs cache, so it re-renders only when it changes.
 */
export const ResultTable = memo(function ResultTable({ result }: { result: QueryResult }) {
  const { columns, rows, row_count, truncated, duration_ms } = result;
  return (
    <div className="space-y-1">
      <div className="max-h-96 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
        <table className="min-w-full border-collapse text-left font-mono text-xs">
          <thead className="sticky top-0 bg-zinc-100 dark:bg-zinc-900">
            <tr>
              {columns.map((column, i) => (
                <th
                  key={i}
                  scope="col"
                  className="border-b border-zinc-200 px-2 py-1 font-semibold dark:border-zinc-800"
                >
                  <div>{column.name}</div>
                  <div className="font-normal text-zinc-500">{column.type}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr
                key={r}
                className="odd:bg-white even:bg-zinc-50 dark:odd:bg-zinc-950 dark:even:bg-zinc-900/40"
              >
                {row.map((value, c) => (
                  <td
                    key={c}
                    className={`whitespace-pre border-b border-zinc-100 px-2 py-0.5 dark:border-zinc-900 ${value === null ? "text-zinc-400 italic" : ""}`}
                  >
                    {formatValue(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-500" data-testid="result-summary">
        {row_count} {row_count === 1 ? "row" : "rows"}
        {truncated ? " (truncated: the result was longer than the display limit)" : ""} ·{" "}
        {duration_ms.toFixed(1)} ms
      </p>
    </div>
  );
});
