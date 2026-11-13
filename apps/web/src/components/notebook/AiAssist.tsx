"use client";

import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";

import { useText } from "@/components/notebook/Cells";
import { AI_LIMITS, ApiError, type AiRequest, type ApiClient, type Decision } from "@/lib/api";
import { replaceCellText, type AiKind, type AiState } from "@/lib/notebook/doc";

const button =
  "rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800";
const aiButton = `${button} border-violet-400 text-violet-700 dark:border-violet-700 dark:text-violet-300`;

/** The latest run of the cell, when it failed: what "Fix with AI" sends. */
export interface FailedRun {
  sql: string;
  error: string;
}

const KIND_LABELS: Record<AiKind, string> = {
  generate: "Generated SQL",
  fix: "Suggested fix",
  explain: "Explanation",
};

/** Characters as the API counts them (code points), not UTF-16 units. */
const length = (text: string) => [...text].length;
const truncate = (text: string, max: number) =>
  length(text) <= max ? text : [...text].slice(0, max).join("");

/**
 * The AI assistant on one SQL cell.
 *
 * Editors ask it to write SQL from a question, explain the cell's SQL, or
 * fix it after a failed run. What the AI is doing comes from the shared
 * document (the sync server writes it from the API's events), so everyone,
 * viewers included, sees it think and sees its suggestion; this component's
 * own state only covers this tab's request and decision while they're in
 * flight.
 *
 * Everything the model wrote is shown as plain text: React escapes it, and
 * nothing here renders markdown or HTML.
 */
export function AiAssist({
  api,
  notebookId,
  doc,
  cellId,
  source,
  ai,
  failedRun,
  readOnly,
}: {
  api: ApiClient;
  notebookId: string;
  doc: Y.Doc;
  cellId: string;
  source: Y.Text;
  ai: AiState | null;
  failedRun: FailedRun | null;
  /** Viewers: they see the AI's state and suggestions, but can't ask or decide. */
  readOnly: boolean;
}) {
  const text = useText(source);
  const [prompt, setPrompt] = useState("");
  const [asking, setAsking] = useState(false);
  // A ref as well as state: two clicks in the same frame must both see it.
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  // The error from this tab's request, tagged with the document's AI state
  // when it arrived: it's shown only until that state changes (the next
  // request, or the server's own account of this one).
  const [requestError, setRequestError] = useState<{ message: string; key: string } | null>(null);
  const [dismissedFailure, setDismissedFailure] = useState<string | null>(null);
  const latestAi = useRef(ai);
  useEffect(() => {
    latestAi.current = ai;
  }, [ai]);

  // Whether this cell is still on this page (see decide).
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the page stops waiting (the server finishes the request anyway).
      controller.current?.abort();
    };
  }, []);

  /**
   * Records a decision on a suggestion and, once the server has taken it,
   * applies an accepted suggestion's SQL to the cell. The server goes first
   * because it picks the one decision that counts: if two editors accept at
   * once, only the one it answers with 200 edits the cell (two clients both
   * replacing the text would leave the SQL in it twice, since Yjs keeps both
   * inserts). Anything else (409: someone decided first; 404; a network
   * error) throws and changes nothing.
   *
   * This lives here rather than in the suggestion's card because the card
   * goes away as soon as the server clears the suggestion from the document,
   * which can happen before this tab gets its 200. This component stays for
   * as long as the cell is on the page. If the 200 arrives after the user
   * left the page, or after the cell was deleted (this component is then
   * gone too), nothing is applied: the decision is recorded, the SQL isn't.
   */
  const decide = async (suggestion: SuggestionState, decision: Decision): Promise<void> => {
    await api.decideSuggestion(notebookId, suggestion.suggestionId, decision);
    if (decision === "accepted" && suggestion.sql !== null && mounted.current) {
      // One transaction by this client: the accepting person's own edit,
      // which their editor's undo reverts in one step.
      replaceCellText(doc, cellId, suggestion.sql);
    }
  };

  const aiKey = (state: AiState | null) => (state ? `${state.status}:${state.requestId}` : "none");
  const thinking = ai?.status === "thinking";
  // One request per cell at a time, and a suggestion has to be decided
  // before the next request would replace it.
  const busy = asking || thinking || ai?.status === "suggestion";
  const busyReason = thinking
    ? "The AI assistant is working on this cell."
    : ai?.status === "suggestion"
      ? "Accept or reject the AI's suggestion first."
      : undefined;

  const ask = async (body: AiRequest) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setAsking(true);
    setRequestError(null);
    const before = latestAi.current?.requestId ?? null;
    const request = new AbortController();
    controller.current = request;
    try {
      await api.askAi(notebookId, cellId, body, request.signal);
      if (body.kind === "generate") setPrompt("");
    } catch (error) {
      if (request.signal.aborted) return;
      const now = latestAi.current;
      // The document already shows this request's failure: don't say it twice.
      if (now?.status === "failed" && now.requestId !== before) return;
      setRequestError({
        message: error instanceof ApiError ? error.message : "Couldn't reach the AI assistant.",
        key: aiKey(now),
      });
    } finally {
      inFlight.current = false;
      setAsking(false);
    }
  };

  const tooLong = (sql: string) => {
    if (length(sql) <= AI_LIMITS.sql) return false;
    setRequestError({
      message: `This SQL is too long for the AI assistant (at most ${AI_LIMITS.sql.toLocaleString("en-US")} characters).`,
      key: aiKey(ai),
    });
    return true;
  };

  const generate = () => {
    const question = prompt.trim();
    if (question) void ask({ kind: "generate", prompt: question });
  };
  const explain = () => {
    if (text.trim() && !tooLong(text)) void ask({ kind: "explain", sql: text });
  };
  const fix = () => {
    if (failedRun && failedRun.sql.trim() && !tooLong(failedRun.sql)) {
      void ask({
        kind: "fix",
        sql: failedRun.sql,
        error: truncate(failedRun.error, AI_LIMITS.error) || "The query failed.",
      });
    }
  };

  return (
    <div className="space-y-2" data-testid="ai-assist">
      {!readOnly && (
        <form
          className="flex flex-wrap items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            generate();
          }}
        >
          <input
            aria-label="Ask AI"
            placeholder="Ask AI to write SQL, e.g. average tip by hour"
            value={prompt}
            maxLength={AI_LIMITS.prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={busy}
            className="min-w-48 flex-1 rounded border border-zinc-300 bg-transparent px-2 py-0.5 text-xs disabled:opacity-60 dark:border-zinc-700"
          />
          <button
            type="submit"
            className={aiButton}
            disabled={busy || !prompt.trim()}
            title={busyReason}
          >
            Ask AI
          </button>
          <button
            type="button"
            className={aiButton}
            onClick={explain}
            disabled={busy || !text.trim()}
            title={busyReason}
          >
            Explain
          </button>
          {failedRun && (
            <button
              type="button"
              className={aiButton}
              onClick={fix}
              disabled={busy}
              title={busyReason}
            >
              Fix with AI
            </button>
          )}
        </form>
      )}

      {thinking ? (
        <p role="status" className="text-xs text-violet-700 dark:text-violet-300">
          AI assistant is thinking…{ai.by ? ` (asked by ${ai.by})` : ""}
        </p>
      ) : (
        asking && (
          <p role="status" className="text-xs text-violet-700 dark:text-violet-300">
            Asking the AI assistant…
          </p>
        )
      )}

      {ai?.status === "failed" && dismissedFailure !== ai.requestId && (
        <div role="alert" className="flex items-start gap-2 text-xs text-red-600">
          <p className="whitespace-pre-wrap">The AI assistant couldn&apos;t help: {ai.message}</p>
          <button className={button} onClick={() => setDismissedFailure(ai.requestId)}>
            Dismiss
          </button>
        </div>
      )}

      {requestError && requestError.key === aiKey(ai) && (
        <div role="alert" className="flex items-start gap-2 text-xs text-red-600">
          <p className="whitespace-pre-wrap">{requestError.message}</p>
          <button className={button} onClick={() => setRequestError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {ai?.status === "suggestion" && (
        <SuggestionCard
          // A new suggestion starts with fresh local state.
          key={ai.suggestionId}
          onDecide={decide}
          text={text}
          suggestion={ai}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}

type SuggestionState = Extract<AiState, { status: "suggestion" }>;

/** What to tell someone whose decision the server didn't take. Nothing was changed either way. */
function decisionError(error: unknown): { message: string; final: boolean } {
  if (error instanceof ApiError && error.status === 409) {
    // Someone else decided first; the document clears the card shortly.
    return { message: "This suggestion was already accepted or rejected.", final: true };
  }
  if (error instanceof ApiError && error.status === 404) {
    return { message: "This suggestion no longer exists.", final: true };
  }
  const reason = error instanceof ApiError ? error.message : "Couldn't reach the server.";
  return {
    message: `Couldn't record your decision: ${reason} Nothing was changed; try again.`,
    final: false,
  };
}

/**
 * A suggestion waiting for a decision. Accepting first records the decision,
 * then puts the suggested SQL in the cell as the accepting person's own edit
 * (see AiAssist's decide); rejecting only records it. Either way the sync
 * server then clears the suggestion for everyone.
 */
function SuggestionCard({
  onDecide,
  text,
  suggestion,
  readOnly,
}: {
  onDecide: (suggestion: SuggestionState, decision: Decision) => Promise<void>;
  /** The cell's current SQL. */
  text: string;
  suggestion: SuggestionState;
  readOnly: boolean;
}) {
  const { kind, sql, baseSql, explanation, valid, by } = suggestion;
  const [deciding, setDeciding] = useState(false);
  // A ref as well as state, so a double click can't send two decisions.
  const inFlight = useRef(false);
  const [decided, setDecided] = useState<Decision | null>(null);
  // Set once the server said the suggestion can't be decided anymore.
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Whether accepting would overwrite SQL the AI didn't see. A fix (and an
  // explanation) was about `baseSql`; a generated query replaces whatever the
  // cell holds, so any SQL there now counts.
  const current = text.trim();
  const changed =
    kind === "generate"
      ? current !== "" && current !== (sql ?? "").trim()
      : current !== (baseSql ?? "").trim();

  const decide = async (decision: Decision) => {
    if (inFlight.current || decided || closed) return;
    inFlight.current = true;
    setDeciding(true);
    setError(null);
    setConfirming(false);
    try {
      await onDecide(suggestion, decision);
      setDecided(decision);
    } catch (e) {
      const { message, final } = decisionError(e);
      setError(message);
      if (final) setClosed(true);
    } finally {
      inFlight.current = false;
      setDeciding(false);
    }
  };

  const accept = () => {
    if (changed && !confirming) setConfirming(true);
    else void decide("accepted");
  };

  return (
    <section
      aria-label="AI suggestion"
      className="space-y-2 rounded-md border border-violet-300 bg-violet-50/60 p-2 text-xs dark:border-violet-800 dark:bg-violet-950/30"
    >
      <header className="flex flex-wrap items-center gap-2">
        <span
          className="flex h-5 items-center rounded px-1.5 font-semibold text-white"
          style={{ backgroundColor: "#7c3aed" }}
        >
          AI
        </span>
        <span className="font-medium">{KIND_LABELS[kind]}</span>
        {by && <span className="text-zinc-500">asked by {by}</span>}
      </header>

      <p className="whitespace-pre-wrap" data-testid="ai-explanation">
        {explanation}
      </p>

      {kind === "fix" && baseSql !== null && sql !== null && (
        <div>
          <p className="font-medium text-zinc-500">Current SQL (replaced)</p>
          <pre
            className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono dark:bg-zinc-900"
            data-testid="ai-base-sql"
          >
            {baseSql}
          </pre>
        </div>
      )}
      {sql !== null && (
        <div>
          <p className="font-medium text-zinc-500">
            {kind === "fix" ? "Suggested fix" : "Suggested SQL"}
          </p>
          <pre
            className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono dark:bg-zinc-900"
            data-testid="ai-sql"
          >
            {sql}
          </pre>
          {/* An explanation has no SQL to validate (the API stores it as not
              valid), so it never gets a badge. */}
          {kind !== "explain" && (
            <p
              data-testid="ai-validation"
              className={valid ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700"}
            >
              {valid
                ? "Checked: the query parses and plans on the dataset."
                : "Not checked: the query didn't pass validation on the dataset. Review it before running."}
            </p>
          )}
        </div>
      )}
      {kind === "explain" && changed && (
        <p className="text-amber-700">The cell&apos;s SQL has changed since this was written.</p>
      )}

      {!readOnly && !decided && !closed && (
        <div className="space-y-1">
          {confirming && (
            <p role="alert" className="text-amber-700">
              {kind === "generate"
                ? "The cell already has SQL in it. Accepting replaces it."
                : "The cell's SQL has changed since the AI looked at it. Accepting replaces your current SQL."}
            </p>
          )}
          <div className="flex gap-1">
            {sql !== null ? (
              <>
                <button
                  className={`${button} border-emerald-600 text-emerald-700 dark:text-emerald-400`}
                  onClick={accept}
                  disabled={deciding}
                >
                  {confirming ? "Replace anyway" : "Accept"}
                </button>
                {confirming ? (
                  <button className={button} onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                ) : (
                  <button
                    className={button}
                    onClick={() => void decide("rejected")}
                    disabled={deciding}
                  >
                    Reject
                  </button>
                )}
              </>
            ) : (
              <button
                className={button}
                onClick={() => void decide("rejected")}
                disabled={deciding}
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}
      {decided && (
        <p role="status" className="text-zinc-500">
          {decided === "accepted" ? "Accepted." : sql === null ? "Dismissed." : "Rejected."}
        </p>
      )}
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
