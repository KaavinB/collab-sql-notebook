"use client";

import { useEffect, useRef, useState } from "react";

import { formatChartTooltip } from "@/lib/notebook/chartTooltip";

/**
 * Renders a Vega-Lite spec built by buildChartSpec.
 *
 * - Vega is loaded on demand, so notebooks without charts don't download it.
 * - Expressions are evaluated by vega-interpreter (`ast: true`), never by
 *   eval/new Function. Full-page Content-Security-Policy support has not yet
 *   been verified.
 * - The loader refuses every network and file load, and every URL Vega would
 *   otherwise sanitize and follow (image marks, links). Specs only carry inline
 *   data anyway; this keeps it that way even if a spec were ever tampered with.
 *   (vega-embed still injects inline <style>, so a CSP must allow inline styles.)
 */
export function Chart({ spec }: { spec: Record<string, unknown> }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let finalize: (() => void) | undefined;
    (async () => {
      try {
        // Inside the try: a chunk that fails to load (offline, or a redeploy
        // while the tab is open) shows a message instead of an empty box.
        const [{ default: embed }, { expressionInterpreter }, vega] = await Promise.all([
          import("vega-embed"),
          import("vega-interpreter"),
          import("vega"),
        ]);
        if (cancelled || !container.current) return;
        const refuse = () => Promise.reject(new Error("Charts can't load external data."));
        const loader = Object.assign(vega.loader(), {
          load: refuse,
          http: refuse,
          file: refuse,
          sanitize: refuse,
        });
        const result = await embed(container.current, spec as never, {
          mode: "vega-lite",
          renderer: "svg",
          actions: false,
          ast: true,
          expr: expressionInterpreter,
          loader,
          // The default formatter turns a column named "image" into an img
          // outside Vega's loader. Our formatter treats all values as text.
          tooltip: { formatTooltip: formatChartTooltip },
        });
        if (cancelled) result.finalize();
        else finalize = () => result.finalize();
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not draw the chart.");
      }
    })();
    return () => {
      cancelled = true;
      finalize?.();
    };
  }, [spec]);

  return (
    <div>
      <div ref={container} className="w-full" data-testid="chart" />
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
