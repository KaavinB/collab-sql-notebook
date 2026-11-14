"use client";

import { useState } from "react";

import { SparkIcon } from "@/components/notebook/AiAssist";
import { aiButton, field } from "@/components/ui";
import { AI_LIMITS } from "@/lib/api";
import { EXAMPLE_QUESTIONS } from "@/lib/notebook/dataGuide";

/**
 * What a new, empty notebook shows instead of a blank page: one big box to
 * ask a question in plain English, and a few example questions to click.
 * Asking adds a query cell and sends the question to the AI assistant.
 */
export function EmptyNotebook({
  onAsk,
  onOpenGuide,
}: {
  onAsk: (question: string) => void;
  onOpenGuide: () => void;
}) {
  const [question, setQuestion] = useState("");
  const submit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) onAsk(trimmed);
  };
  return (
    <section
      aria-label="Start here"
      className="space-y-5 rounded-2xl border border-violet-200 bg-gradient-to-b from-violet-50 to-white px-6 py-8 dark:border-violet-900 dark:from-violet-950/40 dark:to-zinc-950"
    >
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-violet-700 dark:text-violet-300">
          This notebook is empty
        </p>
        <h2 className="text-xl font-semibold tracking-tight">
          Ask a question about NYC taxi trips
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Type it in plain English. The AI assistant writes the query, and you choose whether to use
          it. No SQL needed.
        </p>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit(question);
        }}
      >
        <input
          aria-label="Your question"
          placeholder="e.g. What time of day do people tip the most?"
          value={question}
          maxLength={AI_LIMITS.prompt}
          onChange={(event) => setQuestion(event.target.value)}
          className={`${field} min-w-64 flex-1 py-2.5 text-base`}
          autoFocus
        />
        <button type="submit" className={`${aiButton} px-4 py-2.5`} disabled={!question.trim()}>
          <SparkIcon />
          Ask AI
        </button>
      </form>
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-600">
          Or try one of these
        </p>
        <ul className="flex flex-wrap gap-2">
          {EXAMPLE_QUESTIONS.slice(0, 4).map((example) => (
            <li key={example}>
              <button
                type="button"
                onClick={() => submit(example)}
                className="rounded-full border border-violet-200 bg-white px-3 py-1.5 text-sm text-violet-800 hover:border-violet-400 hover:bg-violet-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 dark:border-violet-800 dark:bg-zinc-900 dark:text-violet-200"
              >
                {example}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-sm text-zinc-600">
        Not sure what&apos;s in the data?{" "}
        <button
          type="button"
          onClick={onOpenGuide}
          className="font-medium text-violet-700 underline-offset-2 hover:underline dark:text-violet-300"
        >
          See what each table holds
        </button>
        . Prefer SQL? Use <strong>+ Query</strong> below.
      </p>
    </section>
  );
}
