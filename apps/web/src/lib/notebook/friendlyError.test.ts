import { describe, expect, it } from "vitest";

import { explainRunError } from "@/lib/notebook/friendlyError";

// Real messages, as the API stores them (DuckDB's for kind "error", our SQL
// check's for "rejected", the runner's for "timeout").
describe("explainRunError", () => {
  it("names a missing column and lists DuckDB's suggestions", () => {
    const friendly = explainRunError({
      kind: "error",
      message:
        'Binder Error: Referenced column "pickup_zone" not found in FROM clause!\nCandidate bindings: "pickup_at", "pickup_location_id", "tip_amount"\n\nLINE 1: SELECT pickup_zone FROM trips LIMIT 5001',
    });
    expect(friendly.title).toBe("There's no column called “pickup_zone”.");
    expect(friendly.suggestions).toEqual(["pickup_at", "pickup_location_id", "tip_amount"]);
  });

  it("names a missing table and the one DuckDB suggests", () => {
    const friendly = explainRunError({
      kind: "error",
      message: 'Catalog Error: Table with name trip does not exist!\nDid you mean "trips"?',
    });
    expect(friendly.title).toBe("There's no table called “trip”.");
    expect(friendly.hint).toMatch(/trips and zones/);
    expect(friendly.suggestions).toEqual(["trips"]);
  });

  it.each([
    ["timeout", "The query took longer than 10 seconds and was stopped.", /time limit/],
    ["rejected", "Only SELECT queries are allowed.", /only read data/],
    [
      "rejected",
      "Could not parse the query: Invalid expression / Unexpected token. Line 1, Col: 12.",
      /typo/,
    ],
    ["rejected", "Run one statement at a time.", /one query at a time/],
    ["rejected", "The query is empty.", /no query/],
    ["rejected", "The function read_csv() is not allowed.", /isn.t available/],
    ["error", "The query needed more memory than a worker is allowed.", /memory/],
    [
      "error",
      'Binder Error: column "payment_type" must appear in the GROUP BY clause or must be part of an aggregate function.',
      /grouped or summarized/,
    ],
    [
      "error",
      'Binder Error: Could not choose a best candidate function for the function call "+(STRING_LITERAL, INTEGER_LITERAL)".',
      /wrong kind of value/,
    ],
    ["error", "Conversion Error: Could not convert string 'x' to INT32", /converted/],
    ["error", "Invalid Input Error: Division by zero in expression (1 // 0).", /divided by zero/],
    ["error", "Parser Error: something new", /couldn't run/],
  ] as const)("explains %s: %s", (kind, message, title) => {
    const friendly = explainRunError({ kind, message });
    expect(friendly.title).toMatch(title);
    expect(friendly.hint.length).toBeGreaterThan(0);
  });

  it.each([
    "The function getenv() is not available: it describes the server, not the data.",
    "duckdb_settings is not available: it describes the server, not the data.",
    "The function read_csv() is not allowed.",
  ])("says something isn't available, in the API's own words: %s", (message) => {
    const friendly = explainRunError({ kind: "rejected", message });
    expect(friendly.title).toBe("This query uses something that isn't available here.");
    expect(friendly.hint).toBe(message);
  });

  it.each([
    "The query contains an invisible character (U+200B) outside a string. Remove it and try again.",
    "The query is longer than 20000 characters.",
    "Something the API adds later.",
  ])("shows any other refusal as the API wrote it: %s", (message) => {
    const friendly = explainRunError({ kind: "rejected", message });
    expect(friendly.title).toBe(message);
    // Never a made-up reason.
    expect(friendly.hint).not.toMatch(/SELECT/);
  });

  it("never treats a long hostile message specially", () => {
    const friendly = explainRunError({ kind: "error", message: "<script>".repeat(1000) });
    expect(friendly.title).toBe("The query couldn't run.");
    expect(friendly.suggestions).toEqual([]);
  });
});
