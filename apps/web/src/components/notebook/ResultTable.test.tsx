// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatValue, ResultTable } from "@/components/notebook/ResultTable";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("formatValue", () => {
  it.each([
    [null, "NULL"],
    ["text", "text"],
    [42, "42"],
    [true, "true"],
    [[1, 2], "[1,2]"],
    [{ a: 1 }, '{"a":1}'],
    ["9007199254740993", "9007199254740993"],
  ])("formats %j as %j", (value, expected) => {
    expect(formatValue(value)).toBe(expected);
  });
});

describe("ResultTable", () => {
  const result = {
    columns: [
      { name: "zone", type: "VARCHAR" },
      { name: "trips", type: "BIGINT" },
      { name: "avg_fare", type: "DOUBLE" },
      { name: "day", type: "TIMESTAMP" },
    ],
    rows: [
      ["JFK Airport", 1200, 61.456, "2024-01-01T00:00:00"],
      [null, 3, null, "2024-01-02T13:05:09"],
    ],
    row_count: 2,
    truncated: false,
    duration_ms: 12.345,
  };

  it("shows column names, readable values, NULLs and a plain summary", () => {
    render(<ResultTable result={result} />);
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual(["zone", "trips", "avg_fare", "day"]);
    // The database type is in the tooltip, in words first.
    expect(headers[1].getAttribute("title")).toBe("Whole number (BIGINT)");
    expect(headers[2].getAttribute("title")).toBe("Amount in US dollars (DOUBLE)");
    const rows = screen.getAllByRole("row").slice(1);
    expect(
      within(rows[0])
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["JFK Airport", "1,200", "$61.46", "Jan 1, 2024"]);
    expect(
      within(rows[1])
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["NULL", "3", "NULL", "Jan 2, 2024, 1:05:09 PM"]);
    expect(screen.getByTestId("result-summary").textContent).toBe("2 rows · took 12 ms");
  });

  it("says when only the first rows are shown", () => {
    render(<ResultTable result={{ ...result, row_count: 5000, truncated: true }} />);
    expect(screen.getByTestId("result-summary").textContent).toMatch(
      /^5,000 rows shown: the first ones only/,
    );
  });

  it("says so when nothing matched", () => {
    render(<ResultTable result={{ ...result, rows: [], row_count: 0 }} />);
    expect(screen.getByText("No rows matched.")).toBeTruthy();
    expect(screen.getByTestId("result-summary").textContent).toMatch(/^0 rows/);
  });

  it("renders values as text, never as markup", () => {
    render(
      <ResultTable
        result={{
          ...result,
          rows: [["<img src=x onerror=alert(1)>", 1, 2, "2024-01-01"]],
          row_count: 1,
        }}
      />,
    );
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });

  it("offers Make a chart only when asked to, and calls it", () => {
    const { rerender } = render(<ResultTable result={result} />);
    expect(screen.queryByRole("button", { name: "Make a chart" })).toBeNull();
    const onMakeChart = vi.fn();
    rerender(<ResultTable result={result} onMakeChart={onMakeChart} />);
    fireEvent.click(screen.getByRole("button", { name: "Make a chart" }));
    expect(onMakeChart).toHaveBeenCalledTimes(1);
  });

  it("downloads the rows as a CSV file made in the browser", async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return "blob:result";
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ResultTable result={result} downloadName="Tips by zone" />);
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(click).toHaveBeenCalledTimes(1);
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("tips-by-zone.csv");
    const text = await created[0].text();
    expect(text).toContain(
      "zone,trips,avg_fare,day\r\nJFK Airport,1200,61.456,2024-01-01T00:00:00",
    );
  });
});
