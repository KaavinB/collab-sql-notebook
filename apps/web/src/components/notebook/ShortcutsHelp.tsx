"use client";

import { useState } from "react";

import { Dialog } from "@/components/Dialog";
import { iconButton } from "@/components/ui";

export const SHORTCUTS: [keys: string, action: string][] = [
  ["Ctrl / ⌘ + Enter", "Run the query you're editing (or finish editing a text cell)"],
  ["Enter", "Ask the AI, in a question box"],
  ["Ctrl / ⌘ + Z", "Undo your own typing (never someone else's)"],
  ["Ctrl / ⌘ + Shift + Z", "Redo"],
  ["Tab", "Indent in the SQL editor; elsewhere, move to the next control"],
  ["Esc", "Close a dialog or panel; in the title, cancel a rename"],
];

/** A small "?" button that lists the keyboard shortcuts. */
export function ShortcutsHelp() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={`${iconButton} border border-zinc-200 dark:border-zinc-800`}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true" className="text-sm font-semibold">
          ?
        </span>
      </button>
      {open && (
        <Dialog title="Keyboard shortcuts" onClose={() => setOpen(false)}>
          <table className="w-full text-sm">
            <tbody>
              {SHORTCUTS.map(([keys, action]) => (
                <tr
                  key={keys}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-800"
                >
                  <th scope="row" className="whitespace-nowrap py-2 pr-4 text-left font-normal">
                    <kbd className="rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 font-sans text-xs dark:border-zinc-700 dark:bg-zinc-900">
                      {keys}
                    </kbd>
                  </th>
                  <td className="py-2 text-zinc-600 dark:text-zinc-400">{action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Dialog>
      )}
    </>
  );
}
