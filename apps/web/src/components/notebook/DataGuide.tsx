"use client";

import { Dialog } from "@/components/Dialog";
import { DATA_DATE_RANGE, DATA_TABLES, EXAMPLE_QUESTIONS } from "@/lib/notebook/dataGuide";

/**
 * "About the data": a side panel describing the taxi dataset in plain words,
 * with example questions that start a new query cell and ask the AI. It sits
 * beside the notebook, so people can read it while they work.
 */
export function DataGuide({
  onClose,
  onAsk,
}: {
  onClose: () => void;
  /** Asks a question in a new cell; absent for viewers, who can't add cells. */
  onAsk?: (question: string) => void;
}) {
  return (
    <Dialog
      side
      title="About the data"
      description={
        <>
          New York City yellow taxi trips with pickups from <strong>{DATA_DATE_RANGE}</strong>,
          published by the NYC Taxi &amp; Limousine Commission.
        </>
      }
      onClose={onClose}
    >
      <div className="space-y-6 text-sm">
        <section aria-labelledby="guide-examples" className="space-y-2">
          <h3 id="guide-examples" className="font-semibold">
            Try a question
          </h3>
          {onAsk ? (
            <>
              <p className="text-zinc-500">
                Click one to add it to the notebook. The AI assistant writes the query for you to
                check and run.
              </p>
              <ul className="space-y-1.5">
                {EXAMPLE_QUESTIONS.map((question) => (
                  <li key={question}>
                    <button
                      onClick={() => onAsk(question)}
                      className="w-full rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2 text-left text-violet-900 hover:border-violet-400 hover:bg-violet-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-100"
                    >
                      {question}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-zinc-600 dark:text-zinc-400">
              {EXAMPLE_QUESTIONS.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          )}
        </section>

        {DATA_TABLES.map((table) => (
          <section key={table.name} aria-labelledby={`guide-${table.name}`} className="space-y-2">
            <h3 id={`guide-${table.name}`} className="font-semibold">
              Table{" "}
              <code className="rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-800">
                {table.name}
              </code>
            </h3>
            <p className="text-zinc-600 dark:text-zinc-400">{table.summary}</p>
            <dl className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {table.columns.map((column) => (
                <div key={column.name} className="space-y-0.5 px-3 py-2">
                  <dt className="flex items-baseline gap-2">
                    <code className="font-mono text-[13px] font-medium">{column.name}</code>
                    <span className="text-xs text-zinc-500">{column.type}</span>
                  </dt>
                  <dd className="text-zinc-600 dark:text-zinc-400">
                    {column.description}
                    {column.codes && (
                      <span className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs">
                        {column.codes.map(([code, meaning]) => (
                          <span key={code} className="contents">
                            <span className="font-mono text-zinc-500">{code}</span>
                            <span>{meaning}</span>
                          </span>
                        ))}
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
