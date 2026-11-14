import { memo, useMemo } from "react";

import { smallButton } from "@/components/ui";
import type { QueryResult } from "@/lib/api";
import { csvFileName, downloadCsv } from "@/lib/notebook/csv";
import {
  columnKind,
  duration,
  formatForDisplay,
  isNumericKind,
  kindLabel,
  rowCount,
} from "@/lib/notebook/format";

export { formatValue } from "@/lib/notebook/format";

/**
 * A query result as a readable table: numbers grouped and right-aligned,
 * money as dollars, dates as dates. The column's database type is in each
 * header's tooltip rather than on screen.
 *
 * Memoized: a result can be thousands of cells, and each run's result object
 * keeps its identity in the runs cache, so it re-renders only when it changes.
 */
export const ResultTable = memo(function ResultTable({
  result,
  onMakeChart,
  downloadName = "query result",
}: {
  result: QueryResult;
  /** Offered as "Make a chart" when given. */
  onMakeChart?: () => void;
  downloadName?: string;
}) {
  const { columns, rows, row_count, truncated, duration_ms } = result;
  const kinds = useMemo(() => columns.map((c) => columnKind(c.type, c.name)), [columns]);

  if (columns.length === 0) {
    return (
      <p className="text-sm text-zinc-500" data-testid="result-summary">
        The query ran but returned no columns.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="max-h-96 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="min-w-full border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-zinc-50 dark:bg-zinc-900">
            <tr>
              {columns.map((column, i) => (
                <th
                  key={i}
                  scope="col"
                  title={`${kindLabel(kinds[i])} (${column.type})`}
                  className={`whitespace-nowrap border-b border-zinc-200 px-3 py-2 text-xs font-semibold text-zinc-700 dark:border-zinc-800 dark:text-zinc-300 ${isNumericKind(kinds[i]) ? "text-right" : ""}`}
                >
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr
                key={r}
                className="odd:bg-white even:bg-zinc-50/60 hover:bg-violet-50/50 dark:odd:bg-zinc-950 dark:even:bg-zinc-900/40"
              >
                {row.map((value, c) => (
                  <td
                    key={c}
                    title={typeof value === "string" && value.length > 60 ? value : undefined}
                    className={`max-w-xs truncate whitespace-pre border-b border-zinc-100 px-3 py-1.5 dark:border-zinc-900 ${value === null ? "italic text-zinc-500" : ""} ${isNumericKind(kinds[c]) ? "text-right tabular-nums" : ""}`}
                  >
                    {formatForDisplay(value, kinds[c], columns[c].name)}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-4 text-center text-zinc-500">
                  No rows matched.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-zinc-500" data-testid="result-summary">
          {truncated
            ? `${rowCount(row_count)} shown: the first ones only, the full answer is longer. Add a filter or group the rows to see all of it.`
            : rowCount(row_count)}
          {" · "}took {duration(duration_ms)}
        </p>
        <div className="ml-auto flex gap-2">
          {onMakeChart && rows.length > 0 && (
            <button
              className={smallButton}
              onClick={onMakeChart}
              title="Draw this result as a chart"
            >
              <ChartIcon />
              Make a chart
            </button>
          )}
          <button
            className={smallButton}
            onClick={() => downloadCsv(result, csvFileName(downloadName))}
            title={
              truncated
                ? "Download the rows shown here as a CSV file (spreadsheet)"
                : "Download as a CSV file (spreadsheet)"
            }
          >
            <DownloadIcon />
            Download CSV
          </button>
        </div>
      </div>
    </div>
  );
});

function ChartIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
      <path d="M2 13h12v1H2zM3 8h2v4H3zM7 4h2v8H7zM11 6h2v6h-2z" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.5]"
    >
      <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M3 13h10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
