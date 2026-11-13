import { notFound } from "next/navigation";

import { SessionGate } from "@/components/auth/SessionGate";
import { NotebookEditor } from "@/components/notebook/NotebookEditor";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NotebookPage({ params }: PageProps<"/notebooks/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
      <SessionGate>
        <NotebookEditor notebookId={id} />
      </SessionGate>
    </main>
  );
}
