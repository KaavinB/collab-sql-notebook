"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { SignIn } from "@/components/auth/SignIn";
import { ApiError, createApiClient, type ApiClient, type User } from "@/lib/api";
import { settlePendingWork } from "@/lib/pendingWork";

type SessionState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; user: User }
  /** Children are unmounted; waiting for their final saves, then logging out. */
  | { status: "signing-out" }
  | { status: "error"; message: string };

interface SessionValue {
  user: User;
  api: ApiClient;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/** The signed-in user. Only usable inside <SessionGate>. */
export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionGate>");
  return value;
}

/**
 * Shows its children only to a signed-in user, and the sign-in page to
 * everyone else. The session itself is an HttpOnly cookie that page code
 * can't read, so "am I signed in?" is answered by asking the API.
 */
export function SessionGate({
  children,
  api: injected,
}: {
  children: React.ReactNode;
  api?: ApiClient;
}) {
  const api = useMemo(() => injected ?? createApiClient(), [injected]);
  const pathname = usePathname();
  const [state, setState] = useState<SessionState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    api.me().then(
      (user) => !cancelled && setState({ status: "signed-in", user }),
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) setState({ status: "signed-out" });
        else
          setState({
            status: "error",
            message: error instanceof ApiError ? error.message : "Could not check your sign-in.",
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Unmount the signed-in pages first: that starts their final saves.
  const signOut = useCallback(async () => setState({ status: "signing-out" }), []);

  useEffect(() => {
    if (state.status !== "signing-out") return;
    let cancelled = false;
    (async () => {
      // Then let those saves finish while the session still exists, and only
      // then end it. (In the other order they'd fail as unauthenticated.)
      await settlePendingWork();
      try {
        await api.logout();
        if (!cancelled) setState({ status: "signed-out" });
      } catch (error) {
        if (!cancelled)
          setState({
            status: "error",
            message: error instanceof ApiError ? error.message : "Could not sign out.",
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.status, api]);

  const value = useMemo(
    () => (state.status === "signed-in" ? { user: state.user, api, signOut } : null),
    [state, api, signOut],
  );

  if (state.status === "loading") return <p className="text-sm text-zinc-500">Loading…</p>;
  if (state.status === "signing-out") return <p className="text-sm text-zinc-500">Signing out…</p>;
  if (state.status === "error")
    return (
      <p role="alert" className="text-sm text-red-600">
        {state.message}
      </p>
    );
  if (state.status === "signed-out" || !value)
    return (
      <SignIn
        api={api}
        next={pathname}
        onSignedIn={(user) => setState({ status: "signed-in", user })}
      />
    );
  return (
    <SessionContext.Provider value={value}>
      <div className="mb-4 flex items-center justify-end gap-3 text-sm text-zinc-500">
        <span data-testid="signed-in-as">{value.user.name}</span>
        <button className="underline" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
      {children}
    </SessionContext.Provider>
  );
}
