/**
 * Shared Tailwind class strings, so buttons and fields look and behave the
 * same everywhere: one type scale, one radius, and a visible keyboard focus
 * ring on every control (mouse clicks don't show it; Tab does).
 */

const focus =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600";

const base = `inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focus}`;

/** The one main action in a place (Run, Ask AI, Create). */
export const primaryButton = `${base} bg-zinc-900 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300`;

/** The AI's own actions are violet, matching its color in presence and cursors. */
export const aiButton = `${base} bg-violet-600 px-3 py-1.5 text-sm text-white hover:bg-violet-700`;

/** Run and Accept and run: they produce an answer. */
export const runButton = `${base} bg-emerald-700 px-3 py-1.5 text-sm text-white hover:bg-emerald-800`;

/** Secondary actions. */
export const secondaryButton = `${base} border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800`;

/** Small secondary actions inside a cell. */
export const smallButton = `${base} border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800`;

/** Small AI actions (Explain this query, Fix with AI). */
export const smallAiButton = `${base} border border-violet-300 bg-white px-2 py-1 text-xs text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:bg-zinc-900 dark:text-violet-300 dark:hover:bg-violet-950`;

/** Icon-only buttons; always paired with an aria-label and a title tooltip. */
export const iconButton = `${base} h-7 w-7 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100`;

/** Destructive confirmation. */
export const dangerButton = `${base} border border-red-300 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-zinc-900 dark:text-red-300`;

/** Text inputs and selects. */
export const field = `rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-500 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 ${focus}`;

export const smallField = `rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 ${focus}`;

/** Plain links styled as text. */
export const link = `rounded text-sm text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100 ${focus}`;
