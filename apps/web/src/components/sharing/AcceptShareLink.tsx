"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useSession } from "@/components/auth/SessionGate";
import { ApiError, type AcceptedShareLink } from "@/lib/api";

// The API's tokens are 43 base64url characters. Anything else can't be one,
// so it isn't sent to the server at all.
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;
const BROKEN_LINK = "This share link doesn't work. It may have been revoked.";

/**
 * Joins the notebook a share link points to, then opens it. Rendered inside
 * <SessionGate>, so someone who isn't signed in signs in first and comes
 * back to this same page.
 */
export function AcceptShareLink({ token }: { token: string }) {
  const { api } = useSession();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // React runs effects twice in development (StrictMode). The request is
  // made once and both runs wait for the same promise.
  const accepting = useRef<Promise<AcceptedShareLink> | null>(null);
  const wellFormed = TOKEN.test(token);

  useEffect(() => {
    if (!wellFormed) return;
    let cancelled = false;
    accepting.current ??= api.acceptShareLink(token);
    accepting.current.then(
      // replace, not push: Back shouldn't return to this page and accept again.
      ({ notebook_id }) => !cancelled && router.replace(`/notebooks/${notebook_id}`),
      (e: unknown) =>
        !cancelled && setError(e instanceof ApiError ? e.message : "Could not open the link."),
    );
    return () => {
      cancelled = true;
    };
  }, [api, token, router, wellFormed]);

  if (error || !wellFormed) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-red-600">
          {error ?? BROKEN_LINK}
        </p>
        <Link href="/" className="text-sm underline">
          Go to your notebooks
        </Link>
      </div>
    );
  }
  return <p className="text-zinc-500">Opening the shared notebook…</p>;
}
