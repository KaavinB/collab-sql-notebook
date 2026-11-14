import { describe, expect, it } from "vitest";

import type { QueryResult } from "@/lib/api";
import { pickChartConfig } from "@/lib/notebook/autoChart";
import { buildChartSpec } from "@/lib/notebook/chart";

const result = (columns: [string, string][]): QueryResult => ({
  columns: columns.map(([name, type]) => ({ name, type })),
  rows: [],
  row_count: 0,
  truncated: false,
  duration_ms: 1,
});

describe("pickChartConfig", () => {
  it("draws change over time as a line", () => {
    const config = pickChartConfig(
      result([
        ["trips", "BIGINT"],
        ["day", "TIMESTAMP"],
        ["revenue", "DOUBLE"],
      ]),
      "c1",
    );
    expect(config).toMatchObject({ source: "c1", mark: "line", x: "day", y: "trips" });
  });

  it("draws categories as bars", () => {
    const config = pickChartConfig(
      result([
        ["borough", "VARCHAR"],
        ["avg_tip", "DOUBLE"],
      ]),
      "c1",
    );
    expect(config).toMatchObject({ mark: "bar", x: "borough", y: "avg_tip", aggregate: "none" });
  });

  it("uses the first column for x when everything is a number", () => {
    const config = pickChartConfig(
      result([
        ["hour", "BIGINT"],
        ["avg_tip", "DOUBLE"],
      ]),
      "c1",
    );
    expect(config).toMatchObject({ mark: "bar", x: "hour", y: "avg_tip" });
  });

  it("counts rows when there's no number to draw", () => {
    const config = pickChartConfig(result([["zone", "VARCHAR"]]), "c1");
    expect(config).toMatchObject({ x: "zone", y: null, aggregate: "count" });
  });

  it("produces a config the chart can draw", () => {
    const data: QueryResult = {
      ...result([
        ["borough", "VARCHAR"],
        ["trips", "BIGINT"],
      ]),
      rows: [["Queens", 3]],
      row_count: 1,
    };
    expect(buildChartSpec(pickChartConfig(data, "c1"), data).ok).toBe(true);
  });
});
