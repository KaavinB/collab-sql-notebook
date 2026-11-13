import { SessionGate } from "@/components/auth/SessionGate";
import { PendingShareLink } from "@/components/sharing/PendingShareLink";

/** Where sign-in returns to from a share link (the token waits in this tab). */
export default function PendingSharePage() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <SessionGate signInNext="/share">
        <PendingShareLink />
      </SessionGate>
    </main>
  );
}
