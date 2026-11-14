"use client";

import { useId, useMemo, useState } from "react";

import { Chart } from "@/components/notebook/Chart";
import { smallField } from "@/components/ui";
import type { QueryResult } from "@/lib/api";
import {
  buildChartSpec,
  CHART_AGGREGATES,
  CHART_MARKS,
  type ChartConfig,
} from "@/lib/notebook/chart";

export interface SqlCellOption {
  id: string;
  label: string;
}

/** Where the chart's data stands: each state has its own explanation. */
export type ChartSource =
  | { kind: "unset" }
  | { kind: "deleted" }
  | { kind: "not-run" }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "load-error" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; result: QueryResult };

const SOURCE_MESSAGES: Record<Exclude<ChartSource["kind"], "ready" | "failed">, string> = {
  unset: "Choose a query to chart.",
  deleted: "The query this chart used was deleted. Choose another one.",
  "not-run": "Run the query first; the chart uses its result.",
  loading: "Loading the query's result…",
  unavailable: "The query's last result is no longer stored. Run it again.",
  "load-error": "Couldn't load the query's result. Reload the page to try again.",
};

interface ChartCellProps {
  config: ChartConfig;
  sqlCells: SqlCellOption[];
  source: ChartSource;
  /** Applies a config change; throws if the value is invalid. */
  onChange: (patch: Partial<ChartConfig>) => void;
  /** View only: the config is shown but every control is disabled. */
  disabled?: boolean;
}

const select = smallField;

const MARK_LABELS: Record<ChartConfig["mark"], string> = {
  bar: "Bars",
  line: "Line",
  point: "Dots",
  area: "Area",
};

const AGGREGATE_LABELS: Record<ChartConfig["aggregate"], string> = {
  none: "Don't combine",
  sum: "Add up (sum)",
  mean: "Average",
  count: "Count rows",
  min: "Smallest",
  max: "Largest",
};

/** A control with its visible label, which is also its accessible name. */
function Field({ label, children }: { label: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

/**
 * The same object for the same config values. The document hands out a new
 * config object on every structural change (any cell added, moved or run), and
 * a new object would rebuild the spec and redraw the chart for nothing.
 */
function useStableConfig(config: ChartConfig): ChartConfig {
  const key = JSON.stringify(config);
  return useMemo(() => JSON.parse(key) as ChartConfig, [key]);
}

export function ChartCellBody({
  config: rawConfig,
  sqlCells,
  source,
  onChange,
  disabled = false,
}: ChartCellProps) {
  const config = useStableConfig(rawConfig);
  const [changeError, setChangeError] = useState<string | null>(null);
  const result = source.kind === "ready" ? source.result : null;
  // Duplicate column names chart the first match, so list each name once.
  const columns = [...new Set(result?.columns.map((c) => c.name) ?? [])];
  // Keep the configured value listed even when the latest result lacks it, so
  // the select shows what's configured instead of silently changing it.
  const withCurrent = (name: string | null) =>
    name && !columns.includes(name) ? [...columns, name] : columns;
  const plan = useMemo(() => (result ? buildChartSpec(config, result) : null), [config, result]);

  const change = (patch: Partial<ChartConfig>) => {
    try {
      onChange(patch);
      setChangeError(null);
    } catch {
      setChangeError(
        "That column name is too long to chart. Give it a short alias in SQL (… AS name).",
      );
    }
  };

  const columnSelect = (
    label: string,
    value: string | null,
    key: "x" | "y" | "color",
    allowNone: boolean,
  ) => (
    <Field label={label}>
      {(id) => (
        <select
          id={id}
          className={select}
          disabled={disabled}
          value={value ?? ""}
          onChange={(e) => change({ [key]: e.target.value || null })}
        >
          <option value="">{allowNone ? "Nothing" : "Choose a column…"}</option>
          {withCurrent(value).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );

  const sourceIsKnown = config.source === null || sqlCells.some((c) => c.id === config.source);
  let message: string | null = null;
  if (source.kind === "failed") message = `The query's last run failed: ${source.message}`;
  else if (source.kind !== "ready") message = SOURCE_MESSAGES[source.kind];
  else if (plan && !plan.ok) message = plan.reason;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Data from">
          {(id) => (
            <select
              id={id}
              className={select}
              disabled={disabled}
              value={config.source ?? ""}
              onChange={(e) => change({ source: e.target.value || null })}
            >
              <option value="">Choose a query…</option>
              {!sourceIsKnown && <option value={config.source!}>(deleted cell)</option>}
              {sqlCells.map((cell) => (
                <option key={cell.id} value={cell.id}>
                  {cell.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Chart type">
          {(id) => (
            <select
              id={id}
              className={select}
              disabled={disabled}
              value={config.mark}
              onChange={(e) => change({ mark: e.target.value as ChartConfig["mark"] })}
            >
              {CHART_MARKS.map((mark) => (
                <option key={mark} value={mark}>
                  {MARK_LABELS[mark]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {columnSelect("Across (x axis)", config.x, "x", false)}
        {columnSelect("Up (y axis)", config.y, "y", config.aggregate === "count")}
        {columnSelect("Color by", config.color, "color", true)}
        <Field label="Combine rows">
          {(id) => (
            <select
              id={id}
              className={select}
              disabled={disabled}
              value={config.aggregate}
              onChange={(e) => change({ aggregate: e.target.value as ChartConfig["aggregate"] })}
            >
              {CHART_AGGREGATES.map((aggregate) => (
                <option key={aggregate} value={aggregate}>
                  {AGGREGATE_LABELS[aggregate]}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {changeError && (
        <p role="alert" className="text-xs text-red-600">
          {changeError}
        </p>
      )}
      {plan?.ok ? (
        <>
          {plan.note && (
            <p className="text-xs text-amber-700" data-testid="chart-note">
              {plan.note}
            </p>
          )}
          <Chart spec={plan.spec} />
        </>
      ) : (
        <p className="text-sm text-zinc-500" data-testid="chart-hint">
          {message}
        </p>
      )}
    </div>
  );
}
