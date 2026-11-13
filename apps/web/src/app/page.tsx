import { NotebookList } from "@/components/NotebookList";
import { SessionGate } from "@/components/auth/SessionGate";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <SessionGate>
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">Notebooks</h1>
        <NotebookList />
      </SessionGate>
    </main>
  );
}
