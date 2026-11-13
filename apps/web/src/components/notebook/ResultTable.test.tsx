// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { formatValue, ResultTable } from "@/components/notebook/ResultTable";

afterEach(cleanup);

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
    ],
    rows: [
      ["JFK Airport", 1200],
      [null, 3],
    ],
    row_count: 2,
    truncated: false,
    duration_ms: 12.345,
  };

  it("shows column names, types, values, NULLs and a summary", () => {
    render(<ResultTable result={result} />);
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual(["zoneVARCHAR", "tripsBIGINT"]);
    const rows = screen.getAllByRole("row").slice(1);
    expect(
      within(rows[0])
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["JFK Airport", "1200"]);
    expect(within(rows[1]).getAllByRole("cell")[0].textContent).toBe("NULL");
    expect(screen.getByTestId("result-summary").textContent).toBe("2 rows · 12.3 ms");
  });

  it("says when the result was truncated", () => {
    render(<ResultTable result={{ ...result, truncated: true }} />);
    expect(screen.getByTestId("result-summary").textContent).toContain("truncated");
  });

  it("renders values as text, never as markup", () => {
    render(
      <ResultTable
        result={{ ...result, rows: [["<img src=x onerror=alert(1)>", 1]], row_count: 1 }}
      />,
    );
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });
});
