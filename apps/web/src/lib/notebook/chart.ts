/**
 * Chart cells (D9).
 *
 * A chart cell stores a small typed ChartConfig in the shared document: which
 * SQL cell it charts, the mark, and which result columns go on x, y and
 * colour. The Vega-Lite spec is built here, in the browser, from the config
 * plus the SQL cell's latest stored result. A stored raw Vega spec could
 * carry data URLs and expressions; this config can't, which matters once the
 * AI writes charts (Phase 3) and collaborators edit them (Phase 2).
 *
 * Built specs only ever contain inline data, with fields renamed to fixed
 * keys ("x", "y", "color"); column names appear only as axis titles. Vega
 * would otherwise read a column named "a.b" as a nested field. If a result
 * has two columns with the same name, the first one is charted.
 *
 * Dates and times: the API sends DuckDB's wall-clock values (its session time
 * zone is UTC, D4) as ISO strings, some without an offset. They're converted
 * to epoch milliseconds read as UTC, and charted on UTC scales with UTC
 * formatting, so the chart shows exactly the values in the result, whatever
 * the viewer's time zone. (Read as local time, a DATE drew a day early west
 * of UTC.)
 */
import { z } from "zod";
import * as Y from "yjs";

import type { QueryResult } from "@/lib/api";

export const CHART_MARKS = ["bar", "line", "point", "area"] as const;
export const CHART_AGGREGATES = ["none", "sum", "mean", "count", "min", "max"] as const;
export type ChartMark = (typeof CHART_MARKS)[number];
export type ChartAggregate = (typeof CHART_AGGREGATES)[number];

// DuckDB names an unaliased expression after its text, so names can be long.
const columnName = z.string().min(1).max(4096);

export const chartConfigSchema = z.object({
  /** The SQL cell whose latest result is charted. */
  source: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .nullable(),
  mark: z.enum(CHART_MARKS),
  x: columnName.nullable(),
  y: columnName.nullable(),
  color: columnName.nullable(),
  aggregate: z.enum(CHART_AGGREGATES),
});
export type ChartConfig = z.infer<typeof chartConfigSchema>;

export const DEFAULT_CHART_CONFIG: ChartConfig = {
  source: null,
  mark: "bar",
  x: null,
  y: null,
  color: null,
  aggregate: "none",
};

const CONFIG_KEYS = Object.keys(DEFAULT_CHART_CONFIG) as (keyof ChartConfig)[];

/** A fresh Y.Map holding the default config, for a new chart cell. */
export function newChartMap(): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const key of CONFIG_KEYS) map.set(key, DEFAULT_CHART_CONFIG[key]);
  return map;
}

/**
 * Reads a chart config defensively, field by field: an invalid field (for
 * example written by a peer running different code) falls back to its
 * default instead of breaking the whole chart.
 */
export function readChartConfig(map: unknown): ChartConfig {
  if (!(map instanceof Y.Map)) return { ...DEFAULT_CHART_CONFIG };
  const config = { ...DEFAULT_CHART_CONFIG } as Record<keyof ChartConfig, unknown>;
  for (const key of CONFIG_KEYS) {
    const value = map.get(key);
    const field = chartConfigSchema.shape[key];
    if (field.safeParse(value).success) config[key] = value;
  }
  return config as ChartConfig;
}

/**
 * Writes some config fields. Each field is its own Y.Map entry, so two
 * people changing different fields at once (one the mark, one the y column)
 * both keep their change. Throws on invalid values.
 */
export function writeChartConfig(map: Y.Map<unknown>, patch: Partial<ChartConfig>): void {
  const valid = chartConfigSchema.partial().strict().parse(patch);
  const apply = () => {
    for (const [key, value] of Object.entries(valid)) map.set(key, value);
  };
  if (map.doc) map.doc.transact(apply);
  else apply();
}

export type FieldType = "quantitative" | "temporal" | "nominal";

const NUMERIC_TYPE =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL(\(\d+, ?\d+\))?)$/;
const TEMPORAL_TYPE = /^(DATE|TIMESTAMP(_S|_MS|_NS)?|TIMESTAMP WITH TIME ZONE)$/;

/**
 * How Vega-Lite should treat a column, from its DuckDB type name. Whole names
 * only: "INTEGER[]" is a list, and "STRUCT(a INTEGER)" a struct, not numbers.
 */
export function fieldType(duckdbType: string): FieldType {
  const type = duckdbType.toUpperCase();
  if (NUMERIC_TYPE.test(type)) return "quantitative";
  if (TEMPORAL_TYPE.test(type)) return "temporal";
  return "nominal";
}

/** The Vega-Lite UTC time unit for a temporal DuckDB type (dates by day, timestamps by second). */
function utcTimeUnit(duckdbType: string): string {
  return duckdbType.toUpperCase() === "DATE"
    ? "utcyearmonthdate"
    : "utcyearmonthdatehoursminutesseconds";
}

/**
 * An ISO date or timestamp from the API as epoch milliseconds, reading
 * wall-clock values (no offset) as UTC. Null if it can't be parsed.
 */
export function utcMillis(value: string): number | null {
  const iso = /[zZ]|[+-]\d\d:\d\d$/.test(value)
    ? value
    : /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `${value}T00:00:00Z`
      : `${value}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** A result value as a chart value. Big integers and DECIMALs arrive as strings (D15). */
function chartValue(value: unknown, type: FieldType): string | number | null {
  if (value === null || value === undefined) return null;
  if (type === "quantitative") {
    const n = typeof value === "number" ? value : Number(value);
    // Precision beyond a double doesn't matter on a chart.
    return Number.isFinite(n) ? n : null;
  }
  if (type === "temporal") return typeof value === "string" ? utcMillis(value) : null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export type ChartPlan =
  /** `note`: something the viewer should know about what's drawn. */
  { ok: true; spec: Record<string, unknown>; note?: string } | { ok: false; reason: string };

const NUMERIC_AGGREGATES: ChartAggregate[] = ["sum", "mean", "min", "max"];

/**
 * Builds a Vega-Lite spec from a config and the source cell's result, or
 * explains what's missing.
 */
export function buildChartSpec(config: ChartConfig, result: QueryResult | null): ChartPlan {
  if (!config.source) return { ok: false, reason: "Choose a SQL cell to chart." };
  if (!result) return { ok: false, reason: "Run the SQL cell first; the chart uses its result." };
  if (!config.x) return { ok: false, reason: "Choose a column for the x axis." };
  const countOnly = config.aggregate === "count";
  if (!config.y && !countOnly) return { ok: false, reason: "Choose a column for the y axis." };

  const column = (name: string | null) => {
    if (name === null) return null;
    const index = result.columns.findIndex((c) => c.name === name);
    if (index === -1) return undefined;
    const duckdbType = result.columns[index].type;
    return { index, name, type: fieldType(duckdbType), duckdbType };
  };
  const x = column(config.x);
  const y = countOnly ? null : column(config.y);
  const color = column(config.color);
  for (const [axis, col, name] of [
    ["x", x, config.x],
    ["y", y, countOnly ? null : config.y],
    ["color", color, config.color],
  ] as const) {
    if (col === undefined) {
      return {
        ok: false,
        reason: `The result has no column "${name}" for ${axis}. Run the cell or pick another column.`,
      };
    }
  }
  if (y && NUMERIC_AGGREGATES.includes(config.aggregate) && y.type !== "quantitative") {
    return { ok: false, reason: `"${y.name}" isn't numeric, so it can't be summed or averaged.` };
  }
  // A truncated result is only the first rows. Summing or counting them in
  // the chart would present a partial total as the real one.
  if (result.truncated && config.aggregate !== "none") {
    return {
      ok: false,
      reason: `The result was cut off at ${result.row_count} rows, so a ${config.aggregate} here would be wrong. Aggregate in SQL instead (GROUP BY) and chart that.`,
    };
  }

  const values = result.rows.map((row) => {
    const datum: Record<string, string | number | null> = { x: chartValue(row[x!.index], x!.type) };
    if (y) datum.y = chartValue(row[y.index], y.type);
    if (color) datum.color = chartValue(row[color.index], color.type);
    return datum;
  });

  // How a column is placed on a channel. DATEs use a one-day UTC time unit,
  // so a bar spans its day. TIMESTAMPs use a UTC scale with no time unit: a
  // time unit makes each bar exactly one unit wide, and with a seconds unit an
  // hourly or daily bar chart would draw bars a fraction of a pixel wide.
  const position = (col: NonNullable<typeof x>) => {
    if (col.type !== "temporal") return {};
    return col.duckdbType.toUpperCase() === "DATE"
      ? { timeUnit: utcTimeUnit(col.duckdbType) }
      : { scale: { type: "utc" } };
  };
  // Tooltips and colour legends always format temporal values with a UTC time
  // unit, so they show the result's wall-clock values in every time zone.
  const labelled = (col: NonNullable<typeof x>) =>
    col.type === "temporal" ? { timeUnit: utcTimeUnit(col.duckdbType) } : {};

  const field = (axis: "x" | "y" | "color", col: NonNullable<typeof x>) => ({
    field: axis,
    type: col.type,
    title: col.name,
  });
  const yTitle = countOnly
    ? "count"
    : config.aggregate === "none"
      ? y!.name
      : `${config.aggregate} of ${y!.name}`;
  const yAggregate = config.aggregate === "none" ? {} : { aggregate: config.aggregate };

  const yEncoding = countOnly
    ? { aggregate: "count", type: "quantitative", title: yTitle }
    : { ...field("y", y!), ...position(y!), ...yAggregate, title: yTitle };
  const tooltip = [
    { ...field("x", x!), ...labelled(x!) },
    countOnly
      ? { aggregate: "count", type: "quantitative", title: yTitle }
      : { ...field("y", y!), ...labelled(y!), ...yAggregate, title: yTitle },
    ...(color ? [{ ...field("color", color), ...labelled(color) }] : []),
  ];

  return {
    ok: true,
    spec: {
      data: { values },
      mark: { type: config.mark },
      encoding: {
        x: { ...field("x", x!), ...position(x!) },
        y: yEncoding,
        ...(color ? { color: { ...field("color", color), ...labelled(color) } } : {}),
        tooltip,
      },
      width: "container",
      height: 300,
    },
    ...(result.truncated
      ? {
          note: `Showing only the first ${result.row_count} rows: the result was cut off. Aggregate in SQL to chart everything.`,
        }
      : {}),
  };
}
