/**
 * "Make a chart": sensible chart settings picked from a result's columns, so
 * one click draws something useful. People can change every setting after.
 *
 * - x: the first date/time column (drawn as a line, the usual way to show
 *   change over time); else the first text column (bars, one per category);
 *   else the first column.
 * - y: the first number column that isn't x.
 * - No number column at all: count the rows per x value instead.
 */
import type { QueryResult } from "@/lib/api";
import { DEFAULT_CHART_CONFIG, fieldType, type ChartConfig } from "@/lib/notebook/chart";

export function pickChartConfig(result: QueryResult, sourceCellId: string): ChartConfig {
  const columns = result.columns.map((column, index) => ({
    ...column,
    index,
    kind: fieldType(column.type),
  }));
  const temporal = columns.find((c) => c.kind === "temporal");
  const nominal = columns.find((c) => c.kind === "nominal");
  const x = temporal ?? nominal ?? columns[0];
  const y = columns.find((c) => c.kind === "quantitative" && c.index !== x?.index);
  const config: ChartConfig = {
    ...DEFAULT_CHART_CONFIG,
    source: sourceCellId,
    mark: temporal && x === temporal ? "line" : "bar",
    x: x?.name ?? null,
    y: y?.name ?? null,
    aggregate: y ? "none" : "count",
  };
  return config;
}
