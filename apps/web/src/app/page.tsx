import { NotebookList } from "@/components/NotebookList";
import { SessionGate } from "@/components/auth/SessionGate";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
      <SessionGate>
        <NotebookList />
      </SessionGate>
    </main>
  );
}
