/**
 * Showing query results to people: readable numbers, money and dates.
 *
 * The API sends values as strict JSON with each column's DuckDB type: big
 * integers and DECIMALs arrive as strings (to keep their precision), dates and
 * timestamps as ISO 8601 wall-clock strings in UTC. Formatting here is display
 * only; CSV downloads and charts use the raw values.
 *
 * The locale is fixed (en-US), so a result looks the same to everyone sharing
 * the notebook, and tests don't depend on the machine.
 */
import { fieldType } from "@/lib/notebook/chart";

const LOCALE = "en-US";

export type ColumnKind = "integer" | "decimal" | "money" | "date" | "timestamp" | "text" | "other";

const INTEGER_TYPE =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT)$/;

// Dollars are shown only when a column is clearly money: one of the taxi
// data's money columns, or a name that is or ends with a money word as a
// whole word ("avg_tip", "total_amount", "revenue"). Matching words inside
// names would put "$" on "avg_taxi_speed_mph" or "total_trips", and a wrong
// "$" misleads more than a plain number does. Statistics of money
// ("stddev_tip", "tip_fare_corr") aren't amounts either.
const MONEY_COLUMNS = new Set([
  "fare_amount",
  "extra",
  "mta_tax",
  "tip_amount",
  "tolls_amount",
  "improvement_surcharge",
  "total_amount",
  "congestion_surcharge",
  "airport_fee",
]);
const MONEY_NAME = /(^|_)(amount|fare|fares|tip|tips|fee|fees|toll|tolls|cost|price|revenue)$/i;
const NOT_MONEY_NAME =
  /(^|_)(stddev|stdev|std|var|variance|corr|ratio|pct|percent|share|fraction|rate|count|num|per)(_|$)/i;

function isMoneyName(name: string): boolean {
  const lower = name.toLowerCase();
  if (MONEY_COLUMNS.has(lower)) return true;
  return MONEY_NAME.test(lower) && !NOT_MONEY_NAME.test(lower);
}

// Integers that are labels, not quantities: "2,024" or "1,234" grouping would
// be wrong for a year or an ID.
const LABEL_INTEGER_NAME = /(^|_)(id|year|code|type|vendor|zip)$|^(year|hour|month|day|dow)$/i;

/** How a result column is shown, from its DuckDB type and its name. */
export function columnKind(duckdbType: string, name: string): ColumnKind {
  const type = duckdbType.toUpperCase();
  if (type === "DATE") return "date";
  if (fieldType(type) === "temporal") return "timestamp";
  if (INTEGER_TYPE.test(type)) return "integer";
  if (fieldType(type) === "quantitative") {
    return isMoneyName(name) ? "money" : "decimal";
  }
  if (type === "VARCHAR" || type === "BOOLEAN" || type === "UUID") return "text";
  return "other";
}

/** A short plain-language name for a column's type, for header tooltips. */
export function kindLabel(kind: ColumnKind): string {
  return {
    integer: "Whole number",
    decimal: "Number",
    money: "Amount in US dollars",
    date: "Date",
    timestamp: "Date and time",
    text: "Text",
    other: "Value",
  }[kind];
}

/** Whether a column's values line up on the right (numbers do). */
export function isNumericKind(kind: ColumnKind): boolean {
  return kind === "integer" || kind === "decimal" || kind === "money";
}

const integerFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const moneyFormat = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const decimalFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });
const smallDecimalFormat = new Intl.NumberFormat(LOCALE, { maximumSignificantDigits: 3 });
const dateFormat = new Intl.DateTimeFormat(LOCALE, {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});
const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const dateTimeSecondsFormat = new Intl.DateTimeFormat(LOCALE, {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/** One result value as plain text. React escapes it, so values can't inject markup. */
export function formatValue(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?$/;

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // Big integers and DECIMALs arrive as strings; NaN and Infinity too.
  if (typeof value === "string" && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A value formatted for reading, by its column's kind. Anything that doesn't
 * look like the kind promised (a string where a number was expected, an
 * offset timestamp) is shown exactly as it came, never guessed at.
 */
export function formatForDisplay(value: unknown, kind: ColumnKind, name = ""): string {
  if (value === null || value === undefined) return "NULL";
  switch (kind) {
    case "integer": {
      // Integers beyond 2^53 arrive as strings; formatting them through a
      // double would change their digits, so they're shown as they came.
      if (typeof value === "string") return value;
      const n = asNumber(value);
      if (n === null) return formatValue(value);
      return LABEL_INTEGER_NAME.test(name) ? String(n) : integerFormat.format(n);
    }
    case "money": {
      const n = asNumber(value);
      return n === null ? formatValue(value) : moneyFormat.format(n);
    }
    case "decimal": {
      const n = asNumber(value);
      if (n === null) return formatValue(value);
      return Math.abs(n) < 1 && n !== 0 ? smallDecimalFormat.format(n) : decimalFormat.format(n);
    }
    case "date": {
      if (typeof value !== "string" || !ISO_DATE.test(value)) return formatValue(value);
      return dateFormat.format(new Date(`${value}T00:00:00Z`));
    }
    case "timestamp": {
      if (typeof value !== "string") return formatValue(value);
      const match = ISO_TIMESTAMP.exec(value);
      if (!match) return formatValue(value);
      const [, y, mo, d, h, mi, s, fraction] = match;
      const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
      if (Number.isNaN(date.getTime())) return formatValue(value);
      // Midnight exactly is usually a whole day (date_trunc('day', ...)).
      if (h === "00" && mi === "00" && s === "00" && !fraction) return dateFormat.format(date);
      return (s === "00" ? dateTimeFormat : dateTimeSecondsFormat).format(date);
    }
    default:
      return formatValue(value);
  }
}

/** "1 row", "5,000 rows". */
export function rowCount(count: number): string {
  return `${count.toLocaleString(LOCALE)} ${count === 1 ? "row" : "rows"}`;
}

/** How long the server took, in words people read. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
