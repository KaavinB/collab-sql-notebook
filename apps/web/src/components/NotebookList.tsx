"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { ApiError, createApiClient, type Notebook } from "@/lib/api";

const message = (error: unknown) =>
  error instanceof ApiError ? error.message : "Something went wrong.";

export function NotebookList() {
  const api = useMemo(() => createApiClient(), []);
  const router = useRouter();
  const [notebooks, setNotebooks] = useState<Notebook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.listNotebooks().then(setNotebooks, (e: unknown) => setError(message(e)));
  }, [api]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    // Guard against double submit (double click, double Enter).
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const notebook = await api.createNotebook(trimmed);
      setError(null);
      router.push(`/notebooks/${notebook.id}`);
    } catch (e) {
      setError(message(e));
      setCreating(false);
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

  return (
    <div className="space-y-6">
      <form onSubmit={create} className="flex gap-2">
        <input
          aria-label="New notebook title"
          placeholder="New notebook title"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          className="flex-1 rounded-md border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700"
        />
        <button
          type="submit"
          disabled={!title.trim() || creating}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Create
        </button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {notebooks === null && !error && <p className="text-sm text-zinc-500">Loading…</p>}
      {notebooks?.length === 0 && <p className="text-sm text-zinc-500">No notebooks yet.</p>}
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {notebooks?.map((notebook) => (
          <li key={notebook.id} className="flex items-center gap-3 py-2">
            <Link href={`/notebooks/${notebook.id}`} className="flex-1 hover:underline">
              {notebook.title}
            </Link>
            <span className="text-xs text-zinc-500">
              {new Date(notebook.updated_at).toLocaleString()}
            </span>
            {confirming === notebook.id ? (
              <span className="flex gap-1">
                <button
                  onClick={() => void remove(notebook.id)}
                  className="text-xs text-red-600 hover:underline"
                >
                  Confirm delete
                </button>
                <button onClick={() => setConfirming(null)} className="text-xs hover:underline">
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirming(notebook.id)}
                className="text-xs text-zinc-500 hover:underline"
                aria-label={`Delete ${notebook.title}`}
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
