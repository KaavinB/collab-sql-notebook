import { describe, expect, it } from "vitest";

import { csvFileName, resultToCsv } from "@/lib/notebook/csv";

const base = { row_count: 0, truncated: false, duration_ms: 1 };

describe("resultToCsv", () => {
  it("writes a header and raw values, quoting what needs quoting", () => {
    const csv = resultToCsv({
      ...base,
      columns: [
        { name: "zone", type: "VARCHAR" },
        { name: "trips", type: "BIGINT" },
        { name: "note", type: "VARCHAR" },
      ],
      rows: [
        ["Upper East Side, North", 1200, 'says "hi"'],
        [null, 3, "two\nlines"],
      ],
    });
    expect(csv).toBe(
      'zone,trips,note\r\n"Upper East Side, North",1200,"says ""hi"""\r\n,3,"two\nlines"\r\n',
    );
  });

  it("defuses text a spreadsheet would run as a formula, but keeps negative numbers", () => {
    const csv = resultToCsv({
      ...base,
      columns: [
        { name: "a", type: "VARCHAR" },
        { name: "b", type: "DOUBLE" },
      ],
      rows: [
        ['=HYPERLINK("http://x")', -5.5],
        ["@SUM(A1)", 1],
        ["+1", 2],
      ],
    });
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe('"\'=HYPERLINK(""http://x"")",-5.5');
    expect(lines[2]).toBe("'@SUM(A1),1");
    expect(lines[3]).toBe("'+1,2");
  });

  it("keeps negative DECIMALs and big integers (sent as strings) as numbers", () => {
    const csv = resultToCsv({
      ...base,
      columns: [
        { name: "amount", type: "DECIMAL(10,2)" },
        { name: "big", type: "HUGEINT" },
        { name: "label", type: "VARCHAR" },
      ],
      rows: [["-12.50", "-170141183460469231731687303715884105727", "-12.50"]],
    });
    // A text column's "-12.50" could still be a formula prefix to a
    // spreadsheet; a number column's can't be anything but a number.
    expect(csv.split("\r\n")[1]).toBe("-12.50,-170141183460469231731687303715884105727,'-12.50");
  });

  it("still defuses formula-like text in a number column", () => {
    const csv = resultToCsv({
      ...base,
      columns: [{ name: "n", type: "DOUBLE" }],
      rows: [["=1+1"]],
    });
    expect(csv.split("\r\n")[1]).toBe("'=1+1");
  });

  it("writes nested values as JSON", () => {
    const csv = resultToCsv({
      ...base,
      columns: [{ name: "l", type: "INTEGER[]" }],
      rows: [[[1, 2]]],
    });
    expect(csv).toBe('l\r\n"[1,2]"\r\n');
  });
});

describe("csvFileName", () => {
  it("makes a safe file name", () => {
    expect(csvFileName("Tips by zone / cell 3")).toBe("tips-by-zone-cell-3.csv");
    expect(csvFileName("../../etc")).toBe("etc.csv");
    expect(csvFileName("")).toBe("query-result.csv");
  });
});
