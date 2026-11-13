"use client";

import { useMemo, useState } from "react";

import { Chart } from "@/components/notebook/Chart";
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
  unset: "Choose a SQL cell to chart.",
  deleted: "The SQL cell this chart used was deleted. Choose another one.",
  "not-run": "Run the SQL cell first; the chart uses its result.",
  loading: "Loading the SQL cell's result…",
  unavailable: "The SQL cell's last result is no longer stored. Run it again.",
  "load-error": "Couldn't load the SQL cell's result. Reload the page to try again.",
};

interface ChartCellProps {
  config: ChartConfig;
  sqlCells: SqlCellOption[];
  source: ChartSource;
  /** Applies a config change; throws if the value is invalid. */
  onChange: (patch: Partial<ChartConfig>) => void;
}

const select =
  "rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-xs dark:border-zinc-700";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
      {label}
      {children}
    </label>
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

export function ChartCellBody({ config: rawConfig, sqlCells, source, onChange }: ChartCellProps) {
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
      <select
        aria-label={`Chart ${label}`}
        className={select}
        value={value ?? ""}
        onChange={(e) => change({ [key]: e.target.value || null })}
      >
        <option value="">{allowNone ? "none" : "choose…"}</option>
        {withCurrent(value).map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </Field>
  );

  const sourceIsKnown = config.source === null || sqlCells.some((c) => c.id === config.source);
  let message: string | null = null;
  if (source.kind === "failed") message = `The SQL cell's last run failed: ${source.message}`;
  else if (source.kind !== "ready") message = SOURCE_MESSAGES[source.kind];
  else if (plan && !plan.ok) message = plan.reason;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3">
        <Field label="Data">
          <select
            aria-label="Chart data"
            className={select}
            value={config.source ?? ""}
            onChange={(e) => change({ source: e.target.value || null })}
          >
            <option value="">choose a SQL cell…</option>
            {!sourceIsKnown && <option value={config.source!}>(deleted cell)</option>}
            {sqlCells.map((cell) => (
              <option key={cell.id} value={cell.id}>
                {cell.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Mark">
          <select
            aria-label="Chart mark"
            className={select}
            value={config.mark}
            onChange={(e) => change({ mark: e.target.value as ChartConfig["mark"] })}
          >
            {CHART_MARKS.map((mark) => (
              <option key={mark}>{mark}</option>
            ))}
          </select>
        </Field>
        {columnSelect("x", config.x, "x", false)}
        {columnSelect("y", config.y, "y", config.aggregate === "count")}
        {columnSelect("color", config.color, "color", true)}
        <Field label="Aggregate">
          <select
            aria-label="Chart aggregate"
            className={select}
            value={config.aggregate}
            onChange={(e) => change({ aggregate: e.target.value as ChartConfig["aggregate"] })}
          >
            {CHART_AGGREGATES.map((aggregate) => (
              <option key={aggregate}>{aggregate}</option>
            ))}
          </select>
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
