/**
 * Failed runs in plain language.
 *
 * The API stores a failed run as {kind, message}: "rejected" (our SQL check
 * refused it; the message is written for users), "timeout", or "error"
 * (DuckDB's own message, which is written for programmers: "Binder Error:
 * Referenced column ... not found in FROM clause! Candidate bindings: ...").
 * This turns the common ones into a short title and a hint about what to do.
 * The original message is always kept, for a "Details" disclosure.
 */
import type { Run } from "@/lib/api";

export type RunError = Extract<Run, { status: "error" }>["error"];

export interface FriendlyError {
  /** One sentence: what went wrong. */
  title: string;
  /** What to try next. */
  hint: string;
  /** Columns or tables DuckDB suggested instead, if any. */
  suggestions: string[];
}

const TABLES_HINT = "This dataset has two tables: trips and zones.";
const GUIDE_HINT = "Open “About the data” to see every column, or ask the AI to fix it.";

/** Pulls `"a", "b"` lists out of a DuckDB message. */
function quotedList(text: string): string[] {
  return [...text.matchAll(/"([^"]{1,100})"/g)].map((m) => m[1]).slice(0, 5);
}

export function explainRunError(error: RunError): FriendlyError {
  const message = error.message;
  const none = { suggestions: [] as string[] };

  if (error.kind === "timeout") {
    return {
      ...none,
      title: "This query took longer than the time limit, so it was stopped.",
      hint: "Try asking about a smaller slice of the data, such as one month or one borough, or ask the AI to make it faster.",
    };
  }

  if (error.kind === "rejected") {
    if (/only select/i.test(message)) {
      return {
        ...none,
        title: "This notebook can only read data, not change it.",
        hint: "Queries that change or delete data aren't allowed. Start your query with SELECT, or ask the AI in plain English.",
      };
    }
    if (/could not parse/i.test(message)) {
      return {
        ...none,
        title: "The SQL has a typo or isn't finished.",
        hint: "Check the spelling of keywords like SELECT and FROM, and that brackets and quotes are closed. Fix with AI can usually spot it.",
      };
    }
    if (/^Run one statement at a time/i.test(message)) {
      return {
        ...none,
        title: "Run one query at a time.",
        hint: "Put each query in its own cell (remove the extra semicolon-separated part).",
      };
    }
    if (/^The query is empty/i.test(message)) {
      return { ...none, title: "There's no query to run yet.", hint: "Write SQL, or ask the AI." };
    }
    if (/nested too deeply/i.test(message)) {
      return {
        ...none,
        title: "This query is nested too deeply to check.",
        hint: "Simplify it: fewer brackets or subqueries inside each other.",
      };
    }
    if (/is not (allowed|available)/i.test(message)) {
      // The API's own sentence says what and why ("…: it describes the
      // server, not the data"), so it's the hint.
      return {
        ...none,
        title: "This query uses something that isn't available here.",
        hint: message,
      };
    }
    // Any other refusal: the API writes these messages for users (an
    // invisible character, a query that's too long…), so show its own words
    // rather than guess at a reason.
    return {
      ...none,
      title: message || "This query can't run.",
      hint: "Edit the query, or use Fix with AI.",
    };
  }

  // DuckDB errors.
  const column = /Referenced column "([^"]{1,200})" not found/i.exec(message);
  if (column) {
    const candidates = /Candidate bindings:([^\n]*)/i.exec(message);
    return {
      title: `There's no column called “${column[1]}”.`,
      hint: candidates ? "Did you mean one of these?" : GUIDE_HINT,
      suggestions: candidates ? quotedList(candidates[1]) : [],
    };
  }
  const table = /Table with name ([^\s!]{1,200}) does not exist/i.exec(message);
  if (table) {
    const similar = /Did you mean "([^"]{1,200})"/i.exec(message);
    return {
      title: `There's no table called “${table[1]}”.`,
      hint: TABLES_HINT,
      suggestions: similar ? [similar[1]] : [],
    };
  }
  if (/more memory than/i.test(message) || /out of memory/i.test(message)) {
    return {
      ...none,
      title: "This query needed more memory than it's allowed.",
      hint: "Ask for less at once: add a filter, group the rows (GROUP BY), or return fewer columns.",
    };
  }
  if (/No function matches/i.test(message) || /Could not choose a best candidate/i.test(message)) {
    return {
      ...none,
      title: "A function was used with the wrong kind of value.",
      hint: "For example, adding text to a number. Fix with AI can usually sort this out.",
    };
  }
  if (/must appear in the GROUP BY clause/i.test(message)) {
    return {
      ...none,
      title: "A column needs to be grouped or summarized.",
      hint: "When you use GROUP BY, every other column needs a summary like count(), sum() or avg().",
    };
  }
  if (/Conversion Error/i.test(message)) {
    return {
      ...none,
      title: "A value couldn't be converted to the type the query needs.",
      hint: "Check dates are written like '2024-01-31' and numbers have no quotes.",
    };
  }
  if (/Division by zero/i.test(message)) {
    return {
      ...none,
      title: "The query divided by zero.",
      hint: "Use NULLIF(x, 0) around the number you divide by.",
    };
  }
  return {
    ...none,
    title: "The query couldn't run.",
    hint: "The details below say what the database reported. Fix with AI can often correct it.",
  };
}
