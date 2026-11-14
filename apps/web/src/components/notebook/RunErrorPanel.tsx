"use client";

import { useState } from "react";

import { explainRunError, type RunError } from "@/lib/notebook/friendlyError";

/**
 * A failed run, explained: what went wrong in plain words, what to try, and
 * the main way out (Fix with AI, passed in as `action`). The database's own
 * message stays one click away under "Details", for whoever wants it.
 */
export function RunErrorPanel({ error, action }: { error: RunError; action?: React.ReactNode }) {
  const friendly = explainRunError(error);
  const [open, setOpen] = useState(false);
  return (
    <div
      role="alert"
      data-testid="run-error"
      className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100"
    >
      <p className="font-medium" data-testid="run-error-title">
        {friendly.title}
      </p>
      <p className="text-red-800 dark:text-red-200">{friendly.hint}</p>
      {friendly.suggestions.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Suggestions">
          {friendly.suggestions.map((name) => (
            <li
              key={name}
              className="rounded bg-white px-1.5 py-0.5 font-mono text-xs text-red-900 ring-1 ring-red-200 dark:bg-red-950 dark:text-red-100 dark:ring-red-800"
            >
              {name}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-start gap-3">
        {action}
        {/* The message is only in the page while Details is open, so text
            searches (find in page, screen readers' browse mode, tests) meet
            the plain explanation first, not a hidden duplicate. */}
        <details
          className="min-w-0 flex-1 text-xs text-red-800 dark:text-red-200"
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer select-none py-1.5 hover:underline">Details</summary>
          {open && (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white/70 p-2 font-mono dark:bg-black/30">
              {error.message}
            </pre>
          )}
        </details>
      </div>
    </div>
  );
}
