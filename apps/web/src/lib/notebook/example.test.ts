// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { DATA_TABLES } from "@/lib/notebook/dataGuide";
import { appendCell, orderedCells } from "@/lib/notebook/doc";
import {
  EXAMPLE_SQL,
  markExampleNotebook,
  seedExample,
  takeExampleMark,
} from "@/lib/notebook/example";

afterEach(() => sessionStorage.clear());

describe("the example notebook", () => {
  it("is marked once per creation, in this page only (not in storage a duplicated tab copies)", () => {
    expect(takeExampleMark("nb-1")).toBe(false);
    markExampleNotebook("nb-1");
    expect(takeExampleMark("nb-2")).toBe(false);
    expect(takeExampleMark("nb-1")).toBe(true);
    expect(takeExampleMark("nb-1")).toBe(false);
  });

  it("seeds an intro, a question, its SQL, a chart of it and a next step, in one transaction", () => {
    const doc = new Y.Doc();
    let transactions = 0;
    doc.on("afterTransaction", () => transactions++);
    const toRun = seedExample(doc);
    expect(transactions).toBe(1);
    const cells = orderedCells(doc);
    expect(cells.map((c) => c.type)).toEqual([
      "markdown",
      "markdown",
      "sql",
      "markdown",
      "chart",
      "markdown",
    ]);
    const sql = cells[2];
    expect(toRun).toEqual([sql.id]);
    expect(sql.source!.toString()).toBe(EXAMPLE_SQL);
    expect(cells[4].chart).toMatchObject({
      source: sql.id,
      mark: "bar",
      x: "payment_method",
      y: "trips",
    });
  });

  it("never seeds a notebook that already has cells", () => {
    const doc = new Y.Doc();
    appendCell(doc, "sql");
    expect(seedExample(doc)).toEqual([]);
    expect(orderedCells(doc)).toHaveLength(1);
  });

  it("only uses columns that exist in the dataset", () => {
    const trips = DATA_TABLES.find((t) => t.name === "trips")!;
    const names = new Set(trips.columns.map((c) => c.name));
    for (const used of ["payment_type", "tip_amount"]) expect(names.has(used)).toBe(true);
    expect(EXAMPLE_SQL).toMatch(/from trips/);
  });
});

describe("the data guide", () => {
  it("describes exactly the columns taxi.duckdb has (as built by the ingest)", () => {
    // From services/api/src/notebook_api/dataset/build.py; checked against the
    // database file's information_schema when this guide was written.
    const expected = {
      trips: [
        "vendor_id",
        "pickup_at",
        "dropoff_at",
        "passenger_count",
        "trip_distance",
        "rate_code_id",
        "store_and_fwd_flag",
        "pickup_location_id",
        "dropoff_location_id",
        "payment_type",
        "fare_amount",
        "extra",
        "mta_tax",
        "tip_amount",
        "tolls_amount",
        "improvement_surcharge",
        "total_amount",
        "congestion_surcharge",
        "airport_fee",
      ],
      zones: ["location_id", "borough", "zone", "service_zone"],
    };
    for (const table of DATA_TABLES) {
      expect(new Set(table.columns.map((c) => c.name))).toEqual(
        new Set(expected[table.name as keyof typeof expected]),
      );
    }
    expect(DATA_TABLES.map((t) => t.name)).toEqual(["trips", "zones"]);
  });
});
