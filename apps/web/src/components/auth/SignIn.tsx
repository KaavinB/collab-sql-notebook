"use client";

import { useEffect, useState } from "react";

import { ApiError, type ApiClient, type Providers, type User } from "@/lib/api";

const PROVIDER_LABELS: Record<string, string> = { github: "GitHub", google: "Google" };

// The API redirects back with one of these codes; anything else is ignored.
const SIGNIN_ERRORS: Record<string, string> = {
  denied: "Sign-in was cancelled.",
  expired: "That sign-in took too long or was started elsewhere. Please try again.",
  failed: "Sign-in failed. Please try again.",
};

export function SignIn({
  api,
  next,
  onSignedIn,
}: {
  api: ApiClient;
  next: string;
  onSignedIn: (user: User) => void;
}) {
  const [providers, setProviders] = useState<Providers | null>(null);
  // The reason a sign-in failed comes from the URL the API redirected back
  // to. This component only renders in the browser (after the session check),
  // so reading window.location here is safe.
  const [error, setError] = useState<string | null>(
    () =>
      SIGNIN_ERRORS[new URLSearchParams(window.location.search).get("signin_error") ?? ""] ?? null,
  );
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.providers().then(setProviders, () => setError("Could not load sign-in options."));
  }, [api]);

  const devLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      onSignedIn(await api.devLogin(name.trim()));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Sign-in failed.");
      setBusy(false);
    }
  };

  const none = providers && providers.providers.length === 0 && !providers.dev_login;
  return (
    <div className="mx-auto max-w-sm space-y-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {providers === null && !error && <p className="text-sm text-zinc-500">Loading…</p>}
      {none && (
        <p className="text-sm text-zinc-500">
          No sign-in method is configured on the server (see .env.example).
        </p>
      )}
      {providers?.providers.map((provider) => (
        <a
          key={provider}
          href={api.signInUrl(provider, next)}
          className="block rounded-md border border-zinc-300 px-3 py-2 text-center text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Continue with {PROVIDER_LABELS[provider] ?? provider}
        </a>
      ))}
      {providers?.dev_login && (
        <form
          onSubmit={devLogin}
          className="space-y-2 border-t border-zinc-200 pt-4 dark:border-zinc-800"
        >
          <p className="text-xs text-zinc-500">Development sign-in (no password; local only).</p>
          <div className="flex gap-2">
            <input
              aria-label="Dev user name"
              placeholder="Name"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 rounded-md border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700"
            />
            <button
              type="submit"
              disabled={!name.trim() || busy}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Sign in
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
