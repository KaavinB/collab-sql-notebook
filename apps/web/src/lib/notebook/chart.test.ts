import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { QueryResult } from "@/lib/api";
import {
  buildChartSpec,
  DEFAULT_CHART_CONFIG,
  fieldType,
  newChartMap,
  readChartConfig,
  utcMillis,
  writeChartConfig,
  type ChartConfig,
} from "@/lib/notebook/chart";
import { appendCell, chartMap, orderedCells } from "@/lib/notebook/doc";

const result: QueryResult = {
  columns: [
    { name: "borough", type: "VARCHAR" },
    { name: "trips", type: "BIGINT" },
    { name: "avg.tip", type: "DECIMAL(10,2)" },
    { name: "day", type: "DATE" },
  ],
  rows: [
    ["Manhattan", 8556749, "2.75", "2024-01-01"],
    ["Queens", 837882, "4.10", "2024-01-02"],
    [null, "9007199254740993", null, null],
  ],
  row_count: 3,
  truncated: false,
  duration_ms: 1,
};

const config = (patch: Partial<ChartConfig>): ChartConfig => ({
  ...DEFAULT_CHART_CONFIG,
  source: "cell-1",
  ...patch,
});

function spec(patch: Partial<ChartConfig>) {
  const plan = buildChartSpec(config(patch), result);
  if (!plan.ok) throw new Error(plan.reason);
  return plan.spec as {
    data: { values: Record<string, unknown>[] };
    mark: { type: string };
    encoding: Record<string, Record<string, unknown>>;
  };
}

describe("fieldType", () => {
  it.each([
    ["INTEGER", "quantitative"],
    ["BIGINT", "quantitative"],
    ["HUGEINT", "quantitative"],
    ["DOUBLE", "quantitative"],
    ["DECIMAL(10,2)", "quantitative"],
    ["DATE", "temporal"],
    ["TIMESTAMP", "temporal"],
    ["TIMESTAMP WITH TIME ZONE", "temporal"],
    ["VARCHAR", "nominal"],
    ["BOOLEAN", "nominal"],
    ["DECIMAL(38, 0)", "quantitative"],
    ["TIMESTAMP_NS", "temporal"],
    // Lists and structs of numbers or dates are not numbers or dates.
    ["INTEGER[]", "nominal"],
    ["DOUBLE[3]", "nominal"],
    ["STRUCT(a INTEGER)", "nominal"],
    ["DATE[]", "nominal"],
    ["MAP(VARCHAR, INTEGER)", "nominal"],
  ])("%s is %s", (type, expected) => {
    expect(fieldType(type)).toBe(expected);
  });
});

describe("buildChartSpec", () => {
  it("builds a bar chart with typed encodings and column names as titles", () => {
    const s = spec({ x: "borough", y: "trips" });
    expect(s.mark.type).toBe("bar");
    // Categories keep the query's row order, with horizontal labels when few.
    expect(s.encoding.x).toEqual({
      field: "x",
      type: "nominal",
      title: "borough",
      sort: null,
      axis: { labelAngle: 0, labelLimit: 160 },
    });
    expect(s.encoding.y).toEqual({ field: "y", type: "quantitative", title: "trips" });
    expect(s.data.values[0]).toEqual({ x: "Manhattan", y: 8556749 });
  });

  it("draws bars over whole numbers as categories, not on a continuous axis", () => {
    const result = {
      columns: [
        { name: "payment_type", type: "INTEGER" },
        { name: "trips", type: "BIGINT" },
      ],
      rows: [
        [1, 70],
        [2, 13],
      ],
      row_count: 2,
      truncated: false,
      duration_ms: 1,
    };
    const config = { ...DEFAULT_CHART_CONFIG, source: "s", x: "payment_type", y: "trips" };
    const bar = buildChartSpec(config, result);
    expect(bar.ok && bar.spec.encoding).toMatchObject({ x: { type: "ordinal", sort: null } });
    // A line over the same column stays continuous.
    const line = buildChartSpec({ ...config, mark: "line" }, result);
    expect(line.ok && line.spec.encoding).toMatchObject({ x: { type: "quantitative" } });
  });

  it("leaves labels to Vega's own layout when there are many categories", () => {
    const rows = Array.from({ length: 20 }, (_, i) => [`zone ${i}`, i]);
    const result = {
      columns: [
        { name: "zone", type: "VARCHAR" },
        { name: "trips", type: "BIGINT" },
      ],
      rows,
      row_count: rows.length,
      truncated: false,
      duration_ms: 1,
    };
    const plan = buildChartSpec(
      { ...DEFAULT_CHART_CONFIG, source: "s", x: "zone", y: "trips" },
      result,
    );
    expect(plan.ok && (plan.spec.encoding as { x: object }).x).not.toHaveProperty("axis");
  });

  it("turns DECIMAL and big-integer strings into numbers, and keeps nulls", () => {
    const s = spec({ x: "day", y: "avg.tip" });
    expect(s.encoding.x).toMatchObject({ type: "temporal", timeUnit: "utcyearmonthdate" });
    expect(s.data.values.map((v) => v.x)).toEqual([
      Date.UTC(2024, 0, 1),
      Date.UTC(2024, 0, 2),
      null,
    ]);
    expect(s.data.values.map((v) => v.y)).toEqual([2.75, 4.1, null]);
    const big = spec({ x: "borough", y: "trips" });
    expect(big.data.values[2]).toEqual({ x: null, y: 9007199254740992 });
  });

  it("never passes column names to Vega as field paths", () => {
    // "avg.tip" would be read as a nested field if used as a field name.
    const s = spec({ x: "borough", y: "avg.tip", color: "borough" });
    expect(Object.keys(s.data.values[0]).sort()).toEqual(["color", "x", "y"]);
    expect(s.encoding.y.field).toBe("y");
    expect(s.encoding.y.title).toBe("avg.tip");
  });

  it("only ever contains inline data", () => {
    const json = JSON.stringify(spec({ x: "borough", y: "trips", color: "day" }));
    expect(json).not.toMatch(/"url"/);
    expect(json).not.toMatch(/"signals?"|"expr"|"transform"/);
  });

  it("applies aggregates, and count needs no y column", () => {
    expect(spec({ x: "borough", y: "trips", aggregate: "sum" }).encoding.y).toMatchObject({
      aggregate: "sum",
      title: "sum of trips",
    });
    const count = spec({ x: "borough", aggregate: "count" });
    expect(count.encoding.y).toEqual({ aggregate: "count", type: "quantitative", title: "count" });
    expect(Object.keys(count.data.values[0])).toEqual(["x"]);
  });

  it("supports every mark", () => {
    for (const mark of ["bar", "line", "point", "area"] as const) {
      expect(spec({ x: "day", y: "trips", mark }).mark.type).toBe(mark);
    }
  });

  it.each([
    [{ source: null }, result, /Choose a query/],
    [{}, null, /Run the query first/],
    [{}, result, /x axis/],
    [{ x: "borough" }, result, /y axis/],
    [{ x: "borough", y: "nope" }, result, /no column "nope" for y/],
    [{ x: "borough", y: "trips", color: "gone" }, result, /no column "gone" for color/],
    [{ x: "trips", y: "borough", aggregate: "mean" }, result, /isn't numeric/],
  ] as const)("explains what's missing: %j", (patch, res, reason) => {
    const plan = buildChartSpec(config(patch as Partial<ChartConfig>), res);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(reason);
  });
});

describe("dates and times", () => {
  it.each([
    ["2024-01-01", Date.UTC(2024, 0, 1)],
    ["2024-01-01T23:30:00", Date.UTC(2024, 0, 1, 23, 30)],
    ["2024-01-01T23:30:00.250000", Date.UTC(2024, 0, 1, 23, 30, 0, 250)],
    ["2024-01-01T23:30:00+00:00", Date.UTC(2024, 0, 1, 23, 30)],
    ["2024-01-01T18:30:00-05:00", Date.UTC(2024, 0, 1, 23, 30)],
    ["not a date", null],
  ])("reads %s as wall-clock UTC", (value, expected) => {
    expect(utcMillis(value)).toBe(expected);
  });

  it("puts timestamps on a UTC scale (no time unit) and formats their tooltips in UTC", () => {
    const res: QueryResult = {
      ...result,
      columns: [
        { name: "at", type: "TIMESTAMP" },
        { name: "n", type: "BIGINT" },
      ],
      rows: [["2024-01-01T23:30:00", 1]],
    };
    const plan = buildChartSpec(config({ x: "at", y: "n" }), res);
    if (!plan.ok) throw new Error(plan.reason);
    const encoding = plan.spec.encoding as Record<string, unknown>;
    // A time unit would make each bar one unit (one second) wide.
    expect(encoding.x).toEqual({
      field: "x",
      type: "temporal",
      title: "at",
      scale: { type: "utc" },
    });
    expect((encoding.tooltip as Record<string, unknown>[])[0]).toMatchObject({
      field: "x",
      timeUnit: "utcyearmonthdatehoursminutesseconds",
    });
  });
});

describe("truncated results", () => {
  const truncated = { ...result, truncated: true };

  it("charts the rows it has, with a note saying it's partial", () => {
    const plan = buildChartSpec(config({ x: "borough", y: "trips" }), truncated);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.note).toMatch(/only the first 3 rows/);
  });

  it.each(["sum", "mean", "count", "min", "max"] as const)(
    "refuses to %s a partial result",
    (aggregate) => {
      const plan = buildChartSpec(config({ x: "borough", y: "trips", aggregate }), truncated);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.reason).toMatch(/cut off .* Aggregate in SQL/);
    },
  );

  it("has no note when the result is complete", () => {
    const plan = buildChartSpec(config({ x: "borough", y: "trips" }), result);
    expect(plan.ok && plan.note).toBeFalsy();
  });
});

describe("chart config in the document", () => {
  it("new chart cells get the default config", () => {
    const doc = new Y.Doc();
    appendCell(doc, "chart", "c1");
    expect(orderedCells(doc)[0].chart).toEqual(DEFAULT_CHART_CONFIG);
    expect(orderedCells(doc)[0].type).toBe("chart");
  });

  it("writes fields and reads them back", () => {
    const doc = new Y.Doc();
    appendCell(doc, "chart", "c1");
    writeChartConfig(chartMap(doc, "c1")!, { source: "sql-1", x: "borough", mark: "line" });
    expect(orderedCells(doc)[0].chart).toMatchObject({
      source: "sql-1",
      x: "borough",
      mark: "line",
    });
  });

  it("accepts the long names DuckDB gives unaliased expressions", () => {
    const map = new Y.Doc().getMap<unknown>("chart");
    writeChartConfig(map, { x: "x".repeat(1200) });
    expect(readChartConfig(map).x).toHaveLength(1200);
  });

  it("rejects invalid writes", () => {
    const map = newChartMap();
    expect(() => writeChartConfig(map, { mark: "pie" as never })).toThrow();
    expect(() => writeChartConfig(map, { source: "bad id!" })).toThrow();
    expect(() => writeChartConfig(map, { url: "https://x" } as never)).toThrow();
  });

  it("falls back to defaults field by field for values a peer wrote badly", () => {
    // A Y.Map only returns its values once it's part of a document.
    const map = new Y.Doc().getMap<unknown>("chart");
    map.set("mark", "pie");
    map.set("x", 42);
    map.set("y", "trips");
    expect(readChartConfig(map)).toEqual({ ...DEFAULT_CHART_CONFIG, y: "trips" });
    expect(readChartConfig(undefined)).toEqual(DEFAULT_CHART_CONFIG);
  });

  it("recreates a missing config map instead of failing", () => {
    const doc = new Y.Doc();
    appendCell(doc, "chart", "c1");
    doc.getMap<Y.Map<unknown>>("cells").get("c1")!.delete("chart");
    expect(orderedCells(doc)[0].chart).toEqual(DEFAULT_CHART_CONFIG);
    expect(chartMap(doc, "c1")).toBeInstanceOf(Y.Map);
    expect(chartMap(doc, "missing")).toBeNull();
  });

  it("keeps both people's edits when they change different fields at once", () => {
    const base = new Y.Doc();
    appendCell(base, "chart", "c1");
    const left = new Y.Doc();
    const right = new Y.Doc();
    Y.applyUpdate(left, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(base));
    writeChartConfig(chartMap(left, "c1")!, { mark: "line" });
    writeChartConfig(chartMap(right, "c1")!, { y: "trips" });
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    expect(orderedCells(left)[0].chart).toMatchObject({ mark: "line", y: "trips" });
    expect(orderedCells(right)[0].chart).toEqual(orderedCells(left)[0].chart);
  });
});
