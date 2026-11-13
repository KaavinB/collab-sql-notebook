// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Chart } from "@/components/notebook/Chart";
import { ChartCellBody, type ChartSource } from "@/components/notebook/ChartCell";
import type { QueryResult } from "@/lib/api";
import { buildChartSpec, DEFAULT_CHART_CONFIG, type ChartConfig } from "@/lib/notebook/chart";

afterEach(cleanup);

const result: QueryResult = {
  columns: [
    { name: "borough", type: "VARCHAR" },
    { name: "trips", type: "BIGINT" },
  ],
  rows: [
    ["Manhattan", 100],
    ["Queens", 40],
  ],
  row_count: 2,
  truncated: false,
  duration_ms: 1,
};
const sqlCells = [{ id: "sql-1", label: "SQL cell 1" }];
const ready: ChartSource = { kind: "ready", result };

function renderBody(config: Partial<ChartConfig>, source: ChartSource = ready, onChange = vi.fn()) {
  const props = { config: { ...DEFAULT_CHART_CONFIG, ...config }, sqlCells, source, onChange };
  const view = render(<ChartCellBody {...props} />);
  return { onChange, view, props };
}

describe("ChartCellBody", () => {
  it("offers the SQL cells and the source result's columns", () => {
    renderBody({ source: "sql-1" });
    const data = screen.getByLabelText<HTMLSelectElement>("Chart data");
    expect([...data.options].map((o) => o.textContent)).toContain("SQL cell 1");
    const x = screen.getByLabelText<HTMLSelectElement>("Chart x");
    expect([...x.options].map((o) => o.value)).toEqual(["", "borough", "trips"]);
  });

  it("reports each change as a config patch", () => {
    const { onChange } = renderBody({ source: "sql-1" });
    fireEvent.change(screen.getByLabelText("Chart x"), { target: { value: "borough" } });
    fireEvent.change(screen.getByLabelText("Chart mark"), { target: { value: "line" } });
    fireEvent.change(screen.getByLabelText("Chart color"), { target: { value: "" } });
    expect(onChange.mock.calls).toEqual([
      [{ x: "borough" }],
      [{ mark: "line" }],
      [{ color: null }],
    ]);
  });

  it.each([
    [{ kind: "unset" }, {}, "Choose a SQL cell to chart."],
    [
      { kind: "deleted" },
      { source: "gone" },
      "The SQL cell this chart used was deleted. Choose another one.",
    ],
    [
      { kind: "not-run" },
      { source: "sql-1" },
      "Run the SQL cell first; the chart uses its result.",
    ],
    [{ kind: "loading" }, { source: "sql-1" }, "Loading the SQL cell's result…"],
    [
      { kind: "unavailable" },
      { source: "sql-1" },
      "The SQL cell's last result is no longer stored. Run it again.",
    ],
    [
      { kind: "load-error" },
      { source: "sql-1" },
      "Couldn't load the SQL cell's result. Reload the page to try again.",
    ],
    [
      { kind: "failed", message: "Binder Error: nope" },
      { source: "sql-1" },
      "The SQL cell's last run failed: Binder Error: nope",
    ],
  ] as [ChartSource, Partial<ChartConfig>, string][])(
    "explains the source state %j",
    (source, config, message) => {
      renderBody(config, source);
      expect(screen.getByTestId("chart-hint").textContent).toBe(message);
    },
  );

  it("shows a deleted source as such instead of falling back to the placeholder", () => {
    renderBody({ source: "gone" }, { kind: "deleted" });
    const data = screen.getByLabelText<HTMLSelectElement>("Chart data");
    expect(data.value).toBe("gone");
    expect(data.selectedOptions[0].textContent).toBe("(deleted cell)");
  });

  it("keeps showing a configured column the latest result no longer has", () => {
    renderBody({ source: "sql-1", x: "old_column", y: "trips" });
    expect(screen.getByLabelText<HTMLSelectElement>("Chart x").value).toBe("old_column");
    expect(screen.getByTestId("chart-hint").textContent).toMatch(/no column "old_column"/);
  });

  it("lists duplicate column names once", () => {
    const dupes = {
      ...result,
      columns: [
        { name: "a", type: "BIGINT" },
        { name: "a", type: "BIGINT" },
      ],
    };
    renderBody({ source: "sql-1" }, { kind: "ready", result: dupes });
    const x = screen.getByLabelText<HTMLSelectElement>("Chart x");
    expect([...x.options].map((o) => o.value)).toEqual(["", "a"]);
  });

  it("says so when a change can't be stored, instead of silently ignoring it", () => {
    const onChange = vi.fn(() => {
      throw new Error("too long");
    });
    renderBody({ source: "sql-1" }, ready, onChange);
    fireEvent.change(screen.getByLabelText("Chart x"), { target: { value: "borough" } });
    expect(screen.getByRole("alert").textContent).toMatch(/Give it a short alias/);
  });

  it("notes when a truncated result is charted", () => {
    renderBody(
      { source: "sql-1", x: "borough", y: "trips" },
      { kind: "ready", result: { ...result, truncated: true } },
    );
    expect(screen.getByTestId("chart-note").textContent).toMatch(/only the first 2 rows/);
  });
});

describe("chart identity", () => {
  it("keeps the same spec when the config object changes but its values don't", async () => {
    vi.resetModules();
    const specs: unknown[] = [];
    vi.doMock("@/components/notebook/Chart", () => ({
      Chart: ({ spec }: { spec: unknown }) => {
        specs.push(spec);
        return null;
      },
    }));
    const { ChartCellBody: Body } = await import("@/components/notebook/ChartCell");
    const config = { ...DEFAULT_CHART_CONFIG, source: "sql-1", x: "borough", y: "trips" };
    const props = { sqlCells, source: ready, onChange: vi.fn() };
    const { rerender } = render(<Body {...props} config={config} />);
    rerender(<Body {...props} config={{ ...config }} />); // equal values, new object
    rerender(<Body {...props} config={{ ...config, mark: "line" }} />);
    expect(specs).toHaveLength(3);
    expect(specs[1]).toBe(specs[0]);
    expect(specs[2]).not.toBe(specs[0]);
    vi.doUnmock("@/components/notebook/Chart");
  });
});

describe("Chart (real Vega, SVG renderer)", () => {
  it("draws one bar per row", async () => {
    const plan = buildChartSpec(
      { ...DEFAULT_CHART_CONFIG, source: "sql-1", x: "borough", y: "trips" },
      result,
    );
    if (!plan.ok) throw new Error(plan.reason);
    render(<Chart spec={plan.spec} />);
    await waitFor(
      () => expect(screen.getByTestId("chart").querySelectorAll(".mark-rect path").length).toBe(2),
      { timeout: 5000 },
    );
  });

  it.each([
    [
      "data URL",
      {
        data: { url: "https://example.com/data.json" },
        mark: "bar",
        encoding: { x: { field: "a", type: "nominal" } },
      },
    ],
    [
      "image mark",
      {
        data: { values: [{ u: "https://tracker.example/pixel.png" }] },
        mark: "image",
        encoding: { url: { field: "u", type: "nominal" }, x: { value: 1 }, y: { value: 1 } },
      },
    ],
  ])("never fetches anything external (%s)", async (_label, spec) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const imageSrcs: string[] = [];
    const realSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true,
      set(value: string) {
        imageSrcs.push(value);
      },
      get() {
        return "";
      },
    });
    try {
      render(<Chart spec={spec} />);
      await waitFor(() => expect(screen.getByTestId("chart").querySelector("svg")).not.toBeNull(), {
        timeout: 5000,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(imageSrcs.filter((src) => src.startsWith("http"))).toEqual([]);
      // The URL may appear as text (an aria-label), but no <image> points at it.
      const images = [...screen.getByTestId("chart").querySelectorAll("image")];
      for (const image of images) {
        expect(image.getAttribute("href") ?? "").toBe("");
        expect(image.getAttribute("xlink:href") ?? "").toBe("");
      }
    } finally {
      Object.defineProperty(HTMLImageElement.prototype, "src", realSrc);
      fetchSpy.mockRestore();
      warn.mockRestore();
    }
  });
});
