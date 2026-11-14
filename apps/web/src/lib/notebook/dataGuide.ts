/**
 * "What's in the data": the taxi dataset in plain words, for people who have
 * never seen it. Static on purpose (no API call): the dataset is fixed by the
 * ingest manifest (services/api/src/notebook_api/dataset).
 *
 * The column names and types match taxi.duckdb as built by the ingest
 * (dataset/build.py); the descriptions follow the NYC TLC yellow taxi data
 * dictionary, as build.py stores them as column comments. Code lists (payment
 * types, rate codes) are the ones that dictionary defines; the "0" payment
 * type isn't in it but does occur in the data, on trips that also have no
 * rate code. No row counts are stated here: they'd go stale silently.
 */

export interface GuideColumn {
  name: string;
  /** Plain-language type: what people will see in it. */
  type: "number" | "whole number" | "money (US$)" | "date and time" | "text";
  description: string;
  /** Code meanings, for columns that store numbers standing for categories. */
  codes?: [string, string][];
}

export interface GuideTable {
  name: string;
  summary: string;
  columns: GuideColumn[];
}

/** The pickup dates the data covers (from the ingest manifest's three monthly files). */
export const DATA_DATE_RANGE = "January 1 to March 31, 2024";

export const DATA_TABLES: GuideTable[] = [
  {
    name: "trips",
    summary:
      "One row per yellow taxi ride in New York City, with when and where it started and ended, and what it cost.",
    columns: [
      {
        name: "pickup_at",
        type: "date and time",
        description: "When the meter started (New York local time).",
      },
      {
        name: "dropoff_at",
        type: "date and time",
        description: "When the meter stopped (New York local time).",
      },
      {
        name: "passenger_count",
        type: "whole number",
        description: "Number of passengers, as entered by the driver.",
      },
      {
        name: "trip_distance",
        type: "number",
        description: "Distance driven, in miles.",
      },
      {
        name: "pickup_location_id",
        type: "whole number",
        description: "Taxi zone where the ride started. Match it to zones.location_id for a name.",
      },
      {
        name: "dropoff_location_id",
        type: "whole number",
        description: "Taxi zone where the ride ended. Match it to zones.location_id for a name.",
      },
      {
        name: "payment_type",
        type: "whole number",
        description: "How the rider paid.",
        codes: [
          ["1", "Credit card"],
          ["2", "Cash"],
          ["3", "No charge"],
          ["4", "Dispute"],
          ["5", "Unknown"],
          ["6", "Voided trip"],
          ["0", "Not recorded (these trips have no rate code either)"],
        ],
      },
      {
        name: "fare_amount",
        type: "money (US$)",
        description: "The time-and-distance fare.",
      },
      {
        name: "tip_amount",
        type: "money (US$)",
        description: "Tip. Only card tips are recorded; cash tips are not.",
      },
      {
        name: "tolls_amount",
        type: "money (US$)",
        description: "Bridge and tunnel tolls paid.",
      },
      {
        name: "total_amount",
        type: "money (US$)",
        description: "Total charged to the rider (cash tips not included).",
      },
      {
        name: "extra",
        type: "money (US$)",
        description: "Miscellaneous extras and surcharges.",
      },
      { name: "mta_tax", type: "money (US$)", description: "MTA tax." },
      {
        name: "improvement_surcharge",
        type: "money (US$)",
        description: "Improvement surcharge.",
      },
      {
        name: "congestion_surcharge",
        type: "money (US$)",
        description: "New York State congestion surcharge.",
      },
      {
        name: "airport_fee",
        type: "money (US$)",
        description: "Fee for pickups at LaGuardia and JFK airports.",
      },
      {
        name: "rate_code_id",
        type: "whole number",
        description: "Which fare rate applied.",
        codes: [
          ["1", "Standard rate"],
          ["2", "JFK airport"],
          ["3", "Newark airport"],
          ["4", "Nassau or Westchester"],
          ["5", "Negotiated fare"],
          ["6", "Group ride"],
          ["99", "Unknown"],
        ],
      },
      {
        name: "vendor_id",
        type: "whole number",
        description: "Which technology provider sent the record.",
      },
      {
        name: "store_and_fwd_flag",
        type: "text",
        description:
          "Y if the taxi had no connection and sent the trip later, N if it was sent right away.",
      },
    ],
  },
  {
    name: "zones",
    summary: "The city's taxi zones: a name and borough for each location ID used in trips.",
    columns: [
      {
        name: "location_id",
        type: "whole number",
        description: "Zone ID, used by trips.pickup_location_id and trips.dropoff_location_id.",
      },
      {
        name: "borough",
        type: "text",
        description:
          "Borough: Manhattan, Brooklyn, Queens, Bronx, Staten Island, EWR (Newark Airport), or Unknown / N/A.",
      },
      { name: "zone", type: "text", description: "Neighborhood or place name, e.g. JFK Airport." },
      {
        name: "service_zone",
        type: "text",
        description: "TLC service area, such as Yellow Zone, Boro Zone or Airports.",
      },
    ],
  },
];

/**
 * Questions to start from: answerable from these two tables, phrased the way
 * a curious person would ask them.
 */
export const EXAMPLE_QUESTIONS: string[] = [
  "Which pickup zones are the busiest?",
  "How does the average tip change by hour of the day?",
  "How many trips were there each day?",
  "How do riders pay: card or cash?",
  "What's the average fare from JFK Airport to Manhattan?",
  "Which day of the week has the longest trips?",
];
