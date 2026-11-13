import type { Metadata } from "next";

import { SessionGate } from "@/components/auth/SessionGate";
import { AcceptShareLink } from "@/components/sharing/AcceptShareLink";
import { RememberShareLink } from "@/components/sharing/PendingShareLink";

// The token is in this page's URL. Never send it to another site in a
// Referer header.
export const metadata: Metadata = { referrer: "no-referrer" };

export default async function SharePage({ params }: PageProps<"/share/[token]">) {
  const { token } = await params;
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      {/* Signing in returns to /share, not to this URL, so the token never
          travels through the API's sign-in URL (see lib/pendingShare.ts). */}
      <RememberShareLink token={token} />
      <SessionGate signInNext="/share">
        <AcceptShareLink token={token} />
      </SessionGate>
    </main>
  );
}
