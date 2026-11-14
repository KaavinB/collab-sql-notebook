"use client";

import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";

import { useText } from "@/components/notebook/Cells";
import { aiButton, runButton, smallAiButton, smallButton, field } from "@/components/ui";
import { AI_LIMITS, ApiError, type AiRequest, type ApiClient, type Decision } from "@/lib/api";
import { replaceCellText, type AiKind, type AiState } from "@/lib/notebook/doc";
import { takeQuestion } from "@/lib/notebook/pendingQuestions";

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

export interface AiAssistantOptions {
  api: ApiClient;
  notebookId: string;
  doc: Y.Doc;
  cellId: string;
  source: Y.Text;
  ai: AiState | null;
  failedRun: FailedRun | null;
  /** Viewers: they see the AI's state and suggestions, but can't ask or decide. */
  readOnly: boolean;
}

/**
 * The AI assistant on one SQL cell: its state and actions. The notebook lays
 * the pieces out around the cell (the question box above the SQL, Explain
 * next to Run, Fix with AI inside the error); <AiAssist> below shows them all
 * together.
 *
 * Editors ask it to write SQL from a question, explain the cell's SQL, or
 * fix it after a failed run. What the AI is doing comes from the shared
 * document (the sync server writes it from the API's events), so everyone,
 * viewers included, sees it think and sees its suggestion; this hook's own
 * state only covers this tab's request and decision while they're in flight.
 */
export function useAiAssistant({
  api,
  notebookId,
  doc,
  cellId,
  source,
  ai,
  failedRun,
  readOnly,
}: AiAssistantOptions) {
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
   * which can happen before this tab gets its 200. This hook stays for as
   * long as the cell is on the page. If the 200 arrives after the user left
   * the page, or after the cell was deleted (this hook is then gone too),
   * nothing is applied: the decision is recorded, the SQL isn't.
   *
   * Returns whether the suggested SQL is now in the cell (so "Accept and run"
   * knows it can run it).
   */
  const decide = async (suggestion: SuggestionState, decision: Decision): Promise<boolean> => {
    await api.decideSuggestion(notebookId, suggestion.suggestionId, decision);
    if (decision === "accepted" && suggestion.sql !== null && mounted.current) {
      // One transaction by this client: the accepting person's own edit,
      // which their editor's undo reverts in one step.
      replaceCellText(doc, cellId, suggestion.sql);
      return true;
    }
    return false;
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
    if (inFlight.current || readOnly) return;
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

  const generate = (question = prompt) => {
    const trimmed = question.trim();
    if (trimmed) void ask({ kind: "generate", prompt: truncate(trimmed, AI_LIMITS.prompt) });
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

  // A question queued for this cell when it was created (the empty-notebook
  // box, an example question): show it in the box and send it. Read on a
  // timer that's cancelled on cleanup, so React's development double-mount
  // (mount, unmount, mount) asks once, from the mount that stays.
  const generateRef = useRef(generate);
  useEffect(() => {
    generateRef.current = generate;
  });
  useEffect(() => {
    if (readOnly) return;
    const timer = setTimeout(() => {
      const question = takeQuestion(cellId);
      if (question) {
        setPrompt(question);
        generateRef.current(question);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [cellId, readOnly]);

  return {
    ai,
    text,
    readOnly,
    prompt,
    setPrompt,
    asking,
    thinking,
    busy,
    busyReason,
    generate,
    explain,
    fix,
    canFix: failedRun !== null,
    decide,
    requestError: requestError && requestError.key === aiKey(ai) ? requestError.message : null,
    dismissRequestError: () => setRequestError(null),
    failure:
      ai?.status === "failed" && dismissedFailure !== ai.requestId
        ? { message: ai.message, dismiss: () => setDismissedFailure(ai.requestId) }
        : null,
  };
}

export type AiAssistant = ReturnType<typeof useAiAssistant>;

/**
 * The plain-English question box: the main way into a query cell for
 * someone who doesn't write SQL.
 */
export function AiAskBar({
  assistant,
  inputRef,
  large = false,
}: {
  assistant: AiAssistant;
  inputRef?: React.Ref<HTMLInputElement>;
  /** The roomy version, for a cell that has no SQL yet. */
  large?: boolean;
}) {
  const { prompt, setPrompt, busy, busyReason, generate, readOnly } = assistant;
  if (readOnly) return null;
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        generate();
      }}
    >
      <input
        ref={inputRef}
        aria-label="Ask AI"
        placeholder="Ask a question in plain English, e.g. Which day had the most trips?"
        value={prompt}
        maxLength={AI_LIMITS.prompt}
        onChange={(event) => setPrompt(event.target.value)}
        disabled={busy}
        data-ask-input
        className={`${field} min-w-48 flex-1 ${large ? "py-2 text-base" : ""}`}
      />
      <button
        type="submit"
        className={aiButton}
        disabled={busy || !prompt.trim()}
        title={busyReason ?? "The AI assistant writes SQL that answers your question"}
      >
        <SparkIcon />
        Ask AI
      </button>
    </form>
  );
}

/** "Explain" asks the AI what the cell's SQL does, in plain words. */
export function AiExplainButton({
  assistant,
  label = "Explain",
}: {
  assistant: AiAssistant;
  label?: string;
}) {
  const { busy, busyReason, explain, text, readOnly } = assistant;
  if (readOnly) return null;
  return (
    <button
      type="button"
      className={smallAiButton}
      onClick={explain}
      disabled={busy || !text.trim()}
      title={busyReason ?? "The AI assistant explains this query in plain words"}
    >
      {label}
    </button>
  );
}

/** "Fix with AI", offered when the cell's latest run failed. */
export function AiFixButton({
  assistant,
  primary = false,
}: {
  assistant: AiAssistant;
  primary?: boolean;
}) {
  const { busy, busyReason, fix, canFix, readOnly } = assistant;
  if (readOnly || !canFix) return null;
  return (
    <button
      type="button"
      className={primary ? aiButton : smallAiButton}
      onClick={fix}
      disabled={busy}
      title={busyReason ?? "The AI assistant suggests a corrected query"}
    >
      {primary && <SparkIcon />}
      Fix with AI
    </button>
  );
}

/**
 * What the AI is doing on this cell, for everyone: thinking, a failure, or a
 * suggestion waiting for a decision.
 *
 * Everything the model wrote is shown as plain text: React escapes it, and
 * nothing here renders markdown or HTML.
 */
export function AiActivity({
  assistant,
  onRun,
}: {
  assistant: AiAssistant;
  /** Runs the cell; enables "Accept and run". */
  onRun?: () => void;
}) {
  const { ai, asking, failure, requestError, dismissRequestError, decide, text } = assistant;
  return (
    <>
      {ai?.status === "thinking" ? (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-violet-700 dark:text-violet-300"
        >
          <Spinner />
          <span>AI assistant is thinking…{ai.by ? ` (asked by ${ai.by})` : ""}</span>
        </p>
      ) : (
        asking && (
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-violet-700 dark:text-violet-300"
          >
            <Spinner />
            <span>Asking the AI assistant…</span>
          </p>
        )
      )}

      {failure && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
        >
          <p className="flex-1 whitespace-pre-wrap">
            The AI assistant couldn&apos;t help: {failure.message}
          </p>
          <button className={smallButton} onClick={failure.dismiss}>
            Dismiss
          </button>
        </div>
      )}

      {requestError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
        >
          <p className="flex-1 whitespace-pre-wrap">{requestError}</p>
          <button className={smallButton} onClick={dismissRequestError}>
            Dismiss
          </button>
        </div>
      )}

      {ai?.status === "suggestion" && (
        <SuggestionCard
          // A new suggestion starts with fresh local state.
          key={ai.suggestionId}
          onDecide={decide}
          onRun={onRun}
          text={text}
          suggestion={ai}
          readOnly={assistant.readOnly}
        />
      )}
    </>
  );
}

/** Everything together: the question box, Explain and Fix, and the AI's activity. */
export function AiAssist(props: AiAssistantOptions & { onRun?: () => void }) {
  const assistant = useAiAssistant(props);
  return (
    <div className="space-y-2" data-testid="ai-assist">
      {!props.readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex-1">
            <AiAskBar assistant={assistant} />
          </div>
          <AiExplainButton assistant={assistant} />
          <AiFixButton assistant={assistant} />
        </div>
      )}
      <AiActivity assistant={assistant} onRun={props.onRun} />
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
 * (see useAiAssistant's decide); "Accept and run" then runs it, so the person
 * sees an answer rather than only code. Rejecting only records it. Either way
 * the sync server then clears the suggestion for everyone.
 */
function SuggestionCard({
  onDecide,
  onRun,
  text,
  suggestion,
  readOnly,
}: {
  onDecide: (suggestion: SuggestionState, decision: Decision) => Promise<boolean>;
  onRun?: () => void;
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
  // Waiting for "Replace anyway"; remembers whether the accept should also run.
  const [confirming, setConfirming] = useState<{ run: boolean } | null>(null);

  // Whether accepting would overwrite SQL the AI didn't see. A fix (and an
  // explanation) was about `baseSql`; a generated query replaces whatever the
  // cell holds, so any SQL there now counts.
  const current = text.trim();
  const changed =
    kind === "generate"
      ? current !== "" && current !== (sql ?? "").trim()
      : current !== (baseSql ?? "").trim();

  const decide = async (decision: Decision, run = false) => {
    if (inFlight.current || decided || closed) return;
    inFlight.current = true;
    setDeciding(true);
    setError(null);
    setConfirming(null);
    try {
      const applied = await onDecide(suggestion, decision);
      setDecided(decision);
      if (run && applied) onRun?.();
    } catch (e) {
      const { message, final } = decisionError(e);
      setError(message);
      if (final) setClosed(true);
    } finally {
      inFlight.current = false;
      setDeciding(false);
    }
  };

  const accept = (run: boolean) => {
    if (changed && !confirming) setConfirming({ run });
    else void decide("accepted", run);
  };

  return (
    <section
      aria-label="AI suggestion"
      className="space-y-3 rounded-lg border border-violet-300 bg-violet-50/70 p-3 text-sm dark:border-violet-800 dark:bg-violet-950/30"
    >
      <header className="flex flex-wrap items-center gap-2">
        <span
          className="flex h-5 items-center rounded px-1.5 text-xs font-semibold text-white"
          style={{ backgroundColor: "#7c3aed" }}
        >
          AI
        </span>
        <span className="font-medium">{KIND_LABELS[kind]}</span>
        {by && <span className="text-zinc-600">asked by {by}</span>}
      </header>

      <p
        className="whitespace-pre-wrap text-zinc-800 dark:text-zinc-200"
        data-testid="ai-explanation"
      >
        {explanation}
      </p>

      {kind === "fix" && baseSql !== null && sql !== null && (
        <div>
          <p className="text-xs font-medium text-zinc-600">Current SQL (replaced)</p>
          <pre
            className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-xs dark:bg-zinc-900"
            data-testid="ai-base-sql"
          >
            {baseSql}
          </pre>
        </div>
      )}
      {sql !== null && (
        <div>
          <p className="text-xs font-medium text-zinc-600">
            {kind === "fix" ? "Suggested fix" : "Suggested SQL"}
          </p>
          <pre
            className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-xs dark:bg-zinc-900"
            data-testid="ai-sql"
          >
            {sql}
          </pre>
          {/* An explanation has no SQL to validate (the API stores it as not
              valid), so it never gets a badge. */}
          {kind !== "explain" && (
            <p
              data-testid="ai-validation"
              className={`mt-1 text-xs ${valid ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700"}`}
            >
              {valid
                ? "Checked: the query parses and plans on the dataset."
                : "Not checked: the query didn't pass validation on the dataset. Review it before running."}
            </p>
          )}
        </div>
      )}
      {kind === "explain" && changed && (
        <p className="text-xs text-amber-700">
          The cell&apos;s SQL has changed since this was written.
        </p>
      )}

      {!readOnly && !decided && !closed && (
        <div className="space-y-2">
          {confirming && (
            <p role="alert" className="text-amber-700">
              {kind === "generate"
                ? "The cell already has SQL in it. Accepting replaces it."
                : "The cell's SQL has changed since the AI looked at it. Accepting replaces your current SQL."}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {sql !== null ? (
              confirming ? (
                <>
                  <button
                    className={runButton}
                    onClick={() => void decide("accepted", confirming.run)}
                    disabled={deciding}
                  >
                    Replace anyway
                  </button>
                  <button className={smallButton} onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  {/* A query that passed the check is meant to be run, so
                      "Accept and run" leads. One that didn't should be read
                      first, so plain "Accept" leads and running is the
                      secondary choice. */}
                  {onRun && valid && (
                    <button
                      className={runButton}
                      onClick={() => accept(true)}
                      disabled={deciding}
                      title="Put this SQL in the cell and run it"
                    >
                      Accept and run
                    </button>
                  )}
                  <button
                    className={onRun && valid ? smallButton : runButton}
                    onClick={() => accept(false)}
                    disabled={deciding}
                    title="Put this SQL in the cell without running it"
                  >
                    Accept
                  </button>
                  {onRun && !valid && (
                    <button
                      className={smallButton}
                      onClick={() => accept(true)}
                      disabled={deciding}
                      title="Put this SQL in the cell and run it anyway"
                    >
                      Accept and run
                    </button>
                  )}
                  <button
                    className={smallButton}
                    onClick={() => void decide("rejected")}
                    disabled={deciding}
                    title="Leave the cell as it is"
                  >
                    Reject
                  </button>
                </>
              )
            ) : (
              <button
                className={smallButton}
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
        <p role="status" className="text-zinc-600">
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

export function SparkIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 fill-current">
      <path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6L8 1z" />
    </svg>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
    />
  );
}
