/**
 * Renders built specs with the real Vega and Vega-Lite (headless, no DOM) in
 * time zones on both sides of UTC, and checks what the viewer would read.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as vega from "vega";
import * as vl from "vega-lite";

import type { QueryResult } from "@/lib/api";
import { buildChartSpec, DEFAULT_CHART_CONFIG, type ChartConfig } from "@/lib/notebook/chart";

const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
});

async function render(config: Partial<ChartConfig>, result: QueryResult) {
  const plan = buildChartSpec({ ...DEFAULT_CHART_CONFIG, source: "s", ...config }, result);
  if (!plan.ok) throw new Error(plan.reason);
  const spec = { ...plan.spec, width: 400 } as vl.TopLevelSpec;
  const view = new vega.View(vega.parse(vl.compile(spec).spec), { renderer: "none" });
  await view.runAsync();
  const svg = await view.toSVG();
  const labels = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  const tooltips: string[] = [];
  const barWidths: number[] = [];
  type Node = {
    items?: unknown[];
    tooltip?: Record<string, unknown>;
    marktype?: string;
    width?: number;
  };
  const walk = (node: Node, marktype?: string) => {
    node.items?.forEach((item) => walk(item as Node, node.marktype ?? marktype));
    if (node.tooltip) tooltips.push(Object.values(node.tooltip).join("="));
    if (marktype === "rect" && node.tooltip && typeof node.width === "number") {
      barWidths.push(node.width);
    }
  };
  // Vega's types don't declare the scenegraph root, though it's always there.
  walk((view.scenegraph() as unknown as { root: Parameters<typeof walk>[0] }).root);
  view.finalize();
  return { labels, tooltips, barWidths };
}

const daily: QueryResult = {
  columns: [
    { name: "day", type: "DATE" },
    { name: "trips", type: "BIGINT" },
  ],
  rows: [
    ["2024-01-01", 10],
    ["2024-01-02", 20],
    ["2024-01-03", 30],
  ],
  row_count: 3,
  truncated: false,
  duration_ms: 1,
};

const timed: QueryResult = {
  columns: [
    { name: "at", type: "TIMESTAMP" },
    { name: "trips", type: "BIGINT" },
  ],
  rows: [
    ["2024-01-01T23:30:00", 1],
    ["2024-01-02T00:30:00", 2],
  ],
  row_count: 2,
  truncated: false,
  duration_ms: 1,
};

describe.each(["America/New_York", "UTC", "Asia/Tokyo"])("rendered in %s", (tz) => {
  it("shows each DATE on its own day", async () => {
    process.env.TZ = tz;
    const { labels, tooltips } = await render({ x: "day", y: "trips" }, daily);
    expect(tooltips).toEqual(["Jan 01, 2024=10", "Jan 02, 2024=20", "Jan 03, 2024=30"]);
    expect(labels).toContain("Jan 03, 2024");
  });

  it("shows TIMESTAMPs at their wall-clock time", async () => {
    process.env.TZ = tz;
    const { tooltips } = await render({ x: "at", y: "trips" }, timed);
    expect(tooltips).toEqual(["Jan 01, 2024 23:30:00=1", "Jan 02, 2024 00:30:00=2"]);
  });

  it("groups a DATE sum by the right day", async () => {
    process.env.TZ = tz;
    const twoOnOneDay = {
      ...daily,
      rows: [
        ["2024-01-01", 10],
        ["2024-01-01", 5],
      ],
    };
    const { tooltips } = await render({ x: "day", y: "trips", aggregate: "sum" }, twoOnOneDay);
    expect(tooltips).toEqual(["Jan 01, 2024=15"]);
  });
});

function timestampsEvery(stepHours: number, count: number): QueryResult {
  return {
    columns: [
      { name: "at", type: "TIMESTAMP" },
      { name: "trips", type: "BIGINT" },
    ],
    rows: Array.from({ length: count }, (_, i) => [
      new Date(Date.UTC(2024, 0, 1) + i * stepHours * 3_600_000).toISOString().slice(0, 19),
      i + 1,
    ]),
    row_count: count,
    truncated: false,
    duration_ms: 1,
  };
}

describe.each(["America/New_York", "UTC", "Asia/Tokyo"])("bar widths in %s", (tz) => {
  // date_trunc('hour' | 'day', ...) returns TIMESTAMP: the most common charts.
  it.each([
    ["hourly", 1, 24],
    ["daily", 24, 31],
  ])("draws visible bars for %s TIMESTAMP data", async (_label, stepHours, count) => {
    process.env.TZ = tz;
    const { barWidths, tooltips } = await render(
      { x: "at", y: "trips" },
      timestampsEvery(stepHours, count),
    );
    expect(barWidths).toHaveLength(count);
    expect(Math.min(...barWidths)).toBeGreaterThanOrEqual(1);
    expect(tooltips[0]).toBe("Jan 01, 2024 00:00:00=1");
  });

  it("draws DATE bars a day wide", async () => {
    process.env.TZ = tz;
    const { barWidths } = await render({ x: "day", y: "trips" }, daily);
    expect(Math.min(...barWidths)).toBeGreaterThanOrEqual(1);
  });
});
