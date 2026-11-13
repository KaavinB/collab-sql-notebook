"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AcceptShareLink } from "@/components/sharing/AcceptShareLink";
import { pendingShareToken, rememberShareToken } from "@/lib/pendingShare";

/** Remembers a share link's token before sign-in can take the visitor away. */
export function RememberShareLink({ token }: { token: string }) {
  useEffect(() => rememberShareToken(token), [token]);
  return null;
}

/** /share: finishes joining with the token remembered before signing in. */
export function PendingShareLink() {
  // Rendered only in the browser, after the session check (SessionGate shows
  // children only once the API has answered), so storage is readable here.
  const [token] = useState(() => pendingShareToken());
  if (!token) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-red-600">
          Open the share link again to join the notebook.
        </p>
        <Link href="/" className="text-sm underline">
          Go to your notebooks
        </Link>
      </div>
    );
  }
  return <AcceptShareLink token={token} />;
}
