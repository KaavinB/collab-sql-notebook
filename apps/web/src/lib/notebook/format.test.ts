import { describe, expect, it } from "vitest";

import { columnKind, duration, formatForDisplay, rowCount } from "@/lib/notebook/format";

describe("columnKind", () => {
  it.each([
    ["BIGINT", "trips", "integer"],
    ["DOUBLE", "trip_distance", "decimal"],
    ["DOUBLE", "avg_tip", "money"],
    ["DOUBLE", "total_amount", "money"],
    ["DECIMAL(10,2)", "revenue", "money"],
    ["DOUBLE", "average_fare", "money"],
    ["DOUBLE", "extra", "money"],
    ["DOUBLE", "airport_fee", "money"],
    // Names that only contain a money word, or are statistics of money, aren't dollars.
    ["DOUBLE", "tip_percentage", "decimal"],
    ["DOUBLE", "fare_per_mile", "decimal"],
    ["DOUBLE", "avg_taxi_speed_mph", "decimal"],
    ["DOUBLE", "tip_frequency", "decimal"],
    ["DOUBLE", "tipped_fraction", "decimal"],
    ["DOUBLE", "fraction_tipped", "decimal"],
    ["DOUBLE", "stddev_tip", "decimal"],
    ["DOUBLE", "tip_fare_corr", "decimal"],
    ["DOUBLE", "multiplier", "decimal"],
    ["DOUBLE", "total_passengers", "decimal"],
    ["DOUBLE", "total_trips", "decimal"],
    ["DOUBLE", "subtotal_miles", "decimal"],
    ["DOUBLE", "tip_rate", "decimal"],
    ["DATE", "day", "date"],
    ["TIMESTAMP", "pickup_at", "timestamp"],
    ["VARCHAR", "zone", "text"],
    ["INTEGER[]", "ids", "other"],
  ])("%s %s is %s", (type, name, kind) => {
    expect(columnKind(type, name)).toBe(kind);
  });
});

describe("formatForDisplay", () => {
  it("groups whole numbers, but not IDs, codes or years", () => {
    expect(formatForDisplay(7258145, "integer", "trips")).toBe("7,258,145");
    expect(formatForDisplay(2024, "integer", "year")).toBe("2024");
    expect(formatForDisplay(132, "integer", "pickup_location_id")).toBe("132");
    expect(formatForDisplay(1, "integer", "payment_type")).toBe("1");
  });

  it("shows integers too big for a double exactly as they came", () => {
    expect(formatForDisplay("9007199254740993", "integer", "n")).toBe("9007199254740993");
  });

  it("shows money as dollars and cents", () => {
    expect(formatForDisplay(207415512.64952642, "money")).toBe("$207,415,512.65");
    expect(formatForDisplay(-5.5, "money")).toBe("-$5.50");
    // DECIMALs arrive as strings.
    expect(formatForDisplay("12.345", "money")).toBe("$12.35");
  });

  it("rounds other numbers to what people can read", () => {
    expect(formatForDisplay(4.2096185623216344, "decimal")).toBe("4.21");
    expect(formatForDisplay(0.0021978664746007638, "decimal")).toBe("0.0022");
    expect(formatForDisplay(0, "decimal")).toBe("0");
    expect(formatForDisplay("NaN", "decimal")).toBe("NaN");
  });

  it("shows dates and times in words, in the data's own (UTC wall-clock) time", () => {
    expect(formatForDisplay("2024-03-31", "date")).toBe("Mar 31, 2024");
    expect(formatForDisplay("2024-01-01T00:00:00", "timestamp")).toBe("Jan 1, 2024");
    expect(formatForDisplay("2024-01-01T08:30:00", "timestamp")).toBe("Jan 1, 2024, 8:30 AM");
    expect(formatForDisplay("2024-01-01T23:02:49", "timestamp")).toBe("Jan 1, 2024, 11:02:49 PM");
    // Anything unexpected is shown untouched rather than guessed at.
    expect(formatForDisplay("2024-01-01T00:00:00+05:00", "timestamp")).toBe(
      "2024-01-01T00:00:00+05:00",
    );
  });

  it("shows NULL as NULL and anything else as text", () => {
    expect(formatForDisplay(null, "integer")).toBe("NULL");
    expect(formatForDisplay([1, 2], "other")).toBe("[1,2]");
  });
});

describe("summaries", () => {
  it("counts rows and says how long it took", () => {
    expect(rowCount(1)).toBe("1 row");
    expect(rowCount(5000)).toBe("5,000 rows");
    expect(duration(0.4)).toBe("1 ms");
    expect(duration(174.5)).toBe("175 ms");
    expect(duration(2345)).toBe("2.3 s");
  });
});
