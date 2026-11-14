"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { SparkIcon } from "@/components/notebook/AiAssist";
import { ROLE_LABELS } from "@/components/sharing/SharePanel";
import { dangerButton, field, primaryButton, secondaryButton, smallButton } from "@/components/ui";
import { ApiError, createApiClient, type Notebook } from "@/lib/api";
import { EXAMPLE_TITLE, markExampleNotebook } from "@/lib/notebook/example";

const message = (error: unknown) =>
  error instanceof ApiError ? error.message : "Something went wrong.";

/** A new notebook created without a name gets this one; it can be renamed in the notebook. */
export const UNTITLED = "Untitled notebook";

const whenFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

/** "Edited 5 minutes ago" for recent times, a date otherwise. */
export function editedLabel(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const minutes = Math.round((now - time) / 60_000);
  if (minutes < 1) return "Edited just now";
  if (minutes < 60) return `Edited ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Edited ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `Edited ${whenFormat.format(new Date(time))}`;
}

/**
 * The home page for a signed-in person: what this is, two ways to start
 * (a guided example, or a blank notebook), and their notebooks.
 */
export function NotebookList() {
  const api = useMemo(() => createApiClient(), []);
  const router = useRouter();
  const [notebooks, setNotebooks] = useState<Notebook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [creating, setCreating] = useState<"example" | "blank" | null>(null);

  useEffect(() => {
    api.listNotebooks().then(setNotebooks, (e: unknown) => setError(message(e)));
  }, [api]);

  const create = async (kind: "example" | "blank", name: string) => {
    // Guard against double submit (double click, double Enter).
    if (creating) return;
    setCreating(kind);
    try {
      const notebook = await api.createNotebook(name);
      if (kind === "example") markExampleNotebook(notebook.id);
      setError(null);
      router.push(`/notebooks/${notebook.id}`);
    } catch (e) {
      setError(message(e));
      setCreating(null);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteNotebook(id);
      setNotebooks((prev) => prev?.filter((n) => n.id !== id) ?? null);
      setError(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setConfirming(null);
    }
  };

  const hasNotebooks = (notebooks?.length ?? 0) > 0;

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Explore New York taxi trips, together
        </h1>
        <p className="max-w-2xl text-lg text-zinc-600 dark:text-zinc-400">
          Ask about New York&apos;s yellow cab rides from January to March 2024, in plain English.
          An AI assistant writes the database query for you, the answer comes back as a table or
          chart, and anyone you share the notebook with sees it live.
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            className={`${primaryButton} px-4 py-2.5 text-base`}
            onClick={() => void create("example", EXAMPLE_TITLE)}
            disabled={creating !== null}
          >
            <SparkIcon />
            {creating === "example" ? "Creating…" : "Start with an example"}
          </button>
          <button
            className={`${secondaryButton} px-4 py-2.5 text-base`}
            onClick={() => void create("blank", title.trim() || UNTITLED)}
            disabled={creating !== null}
          >
            {creating === "blank" ? "Creating…" : "New blank notebook"}
          </button>
        </div>
        <p className="text-sm text-zinc-500">
          The example is a short guided tour: a question, the query that answers it, the result and
          a chart.
        </p>
      </section>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <section className="space-y-3" aria-labelledby="your-notebooks">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="your-notebooks" className="text-lg font-semibold">
            Your notebooks
          </h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create("blank", title.trim() || UNTITLED);
            }}
            className="ml-auto flex gap-2"
          >
            <input
              aria-label="New notebook title"
              placeholder="Name a new notebook"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              className={`${field} w-64`}
            />
            <button type="submit" disabled={creating !== null} className={secondaryButton}>
              Create
            </button>
          </form>
        </div>
        {notebooks === null && !error && <p className="text-sm text-zinc-500">Loading…</p>}
        {notebooks?.length === 0 && (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No notebooks yet. Start with the example above, or create a blank one.
          </p>
        )}
        {hasNotebooks && (
          <ul className="divide-y divide-zinc-200 rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950">
            {notebooks?.map((notebook) => (
              <li
                key={notebook.id}
                className="relative flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <div className="min-w-0 flex-1">
                  {/* The link covers the whole row (after:inset-0), so the row is the click target. */}
                  <Link
                    href={`/notebooks/${notebook.id}`}
                    className="block truncate font-medium after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-violet-600"
                  >
                    {notebook.title}
                  </Link>
                  <p className="text-xs text-zinc-500" title={notebook.updated_at}>
                    {editedLabel(notebook.updated_at)}
                  </p>
                </div>
                {/* Shared with you: say how. Your own notebooks need no label. */}
                {notebook.role !== "owner" && (
                  <span
                    className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                    data-testid="notebook-role"
                    title={`Shared with you: you ${notebook.role === "editor" ? "can edit" : "can view"}`}
                  >
                    {ROLE_LABELS[notebook.role]}
                  </span>
                )}
                {/* Only the owner can delete; others can leave from the notebook's Members dialog. */}
                {notebook.role !== "owner" ? null : confirming === notebook.id ? (
                  <span className="relative z-10 flex items-center gap-2">
                    <span className="text-xs text-zinc-600 dark:text-zinc-400">
                      Delete for everyone? This can&apos;t be undone.
                    </span>
                    <button onClick={() => void remove(notebook.id)} className={dangerButton}>
                      Confirm delete
                    </button>
                    <button onClick={() => setConfirming(null)} className={smallButton}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirming(notebook.id)}
                    className={`${smallButton} relative z-10`}
                    aria-label={`Delete ${notebook.title}`}
                    title="Delete this notebook"
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
