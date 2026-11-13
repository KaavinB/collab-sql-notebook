import type { Metadata } from "next";

import { SessionGate } from "@/components/auth/SessionGate";
import { AcceptShareLink } from "@/components/sharing/AcceptShareLink";

// The token is in this page's URL. Never send it to another site in a
// Referer header.
export const metadata: Metadata = { referrer: "no-referrer" };

export default async function SharePage({ params }: PageProps<"/share/[token]">) {
  const { token } = await params;
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <SessionGate>
        <AcceptShareLink token={token} />
      </SessionGate>
    </main>
  );
}
