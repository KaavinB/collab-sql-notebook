/**
 * Typed client for the FastAPI service.
 *
 * Every response is validated with zod before the app uses it, so a changed
 * or broken API fails here with a clear error instead of deep inside a
 * component.
 */
import { z } from "zod";

import { apiBaseUrl } from "@/lib/env";

// Requests that only touch Postgres.
const DEFAULT_TIMEOUT_MS = 15_000;
// Running a query: the server may wait for a free worker
// (QUERY_QUEUE_TIMEOUT_SECONDS, default 5) and then for the query
// (QUERY_TIMEOUT_SECONDS, default 10, plus a 2 s kill grace). This must stay
// above that total; if those server settings are raised, raise this too, or
// the client gives up on a run the server still completes and stores.
const RUN_TIMEOUT_MS = 60_000;
// Asking the AI assistant: the API answers once it's done, after up to three
// model calls, each SQL answer validated on a query worker. The sync server
// treats a request still running after two minutes as dead, so waiting longer
// than that is pointless; this leaves a little margin past it. Everyone (the
// asker too) follows the request through the document meanwhile.
const AI_TIMEOUT_MS = 130_000;

export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const notebookSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  /** The signed-in user's role in this notebook. */
  role: z.enum(ROLES),
});
export type Notebook = z.infer<typeof notebookSchema>;

export const userSchema = z.object({ id: z.uuid(), name: z.string() });
export type User = z.infer<typeof userSchema>;

export const PROVIDERS = ["github", "google"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

const providersSchema = z.object({
  providers: z.array(z.enum(PROVIDERS)),
  dev_login: z.boolean(),
});
export type Providers = z.infer<typeof providersSchema>;

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

export const queryResultSchema = z.object({
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
  rows: z.array(z.array(jsonValue)),
  row_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  duration_ms: z.number().nonnegative(),
});
export type QueryResult = z.infer<typeof queryResultSchema>;

const runBase = {
  id: z.uuid(),
  cell_id: z.string(),
  sql: z.string(),
  created_at: z.string(),
};

/** A stored run: either a result or an error, never both (as the database enforces). */
export const runSchema = z.discriminatedUnion("status", [
  z.object({ ...runBase, status: z.literal("ok"), result: queryResultSchema, error: z.null() }),
  z.object({
    ...runBase,
    status: z.literal("error"),
    result: z.null(),
    error: z.object({ kind: z.enum(["rejected", "error", "timeout"]), message: z.string() }),
  }),
]);
export type Run = z.infer<typeof runSchema>;

/** Roles a share link can carry, or that the owner can give: never "owner". */
export const SHARED_ROLES = ["editor", "viewer"] as const;
export type SharedRole = (typeof SHARED_ROLES)[number];

export const shareLinkSchema = z.object({
  id: z.uuid(),
  role: z.enum(SHARED_ROLES),
  created_at: z.string(),
});
export type ShareLink = z.infer<typeof shareLinkSchema>;

/** A just-created link. The token is only ever returned here, once. */
export const createdShareLinkSchema = shareLinkSchema.extend({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),
});
export type CreatedShareLink = z.infer<typeof createdShareLinkSchema>;

const acceptedShareLinkSchema = z.object({
  notebook_id: z.uuid(),
  /** The role the user has now, which may be higher than the link's. */
  role: z.enum(ROLES),
});
export type AcceptedShareLink = z.infer<typeof acceptedShareLinkSchema>;

export const memberSchema = z.object({
  user_id: z.uuid(),
  name: z.string(),
  role: z.enum(ROLES),
});
export type Member = z.infer<typeof memberSchema>;

export const syncTicketSchema = z.object({
  ticket: z.string().min(1),
  /** The sync server's WebSocket URL; anything else is refused. */
  url: z.string().regex(/^wss?:\/\/\S+$/),
  role: z.enum(ROLES),
});
export type SyncTicket = z.infer<typeof syncTicketSchema>;

/** What the AI assistant is asked to do for a cell. Lengths are the API's limits. */
export const AI_LIMITS = { prompt: 2_000, sql: 20_000, error: 4_000 } as const;
export type AiRequest =
  | { kind: "generate"; prompt: string }
  | { kind: "fix"; sql: string; error: string }
  | { kind: "explain"; sql: string };

export const SUGGESTION_STATUSES = ["pending", "accepted", "rejected"] as const;
export type Decision = "accepted" | "rejected";

/** A suggestion from the AI assistant, as stored. */
export const suggestionSchema = z.object({
  id: z.uuid(),
  cell_id: z.string(),
  kind: z.enum(["generate", "fix", "explain"]),
  status: z.enum(SUGGESTION_STATUSES),
  /** Null for an explanation. */
  sql: z.string().nullable(),
  explanation: z.string(),
  /** The cell's SQL the request was about (fix, explain); null for generate. */
  base_sql: z.string().nullable(),
  /** Whether the SQL passed validation (parse and plan) on the database. */
  valid: z.boolean(),
  created_at: z.string(),
});
export type Suggestion = z.infer<typeof suggestionSchema>;

const errorBodySchema = z.object({
  detail: z.object({ kind: z.string(), message: z.string() }),
});

/** A failed API call. `kind` comes from the server ("not_found", "busy", ...) or the client. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type FetchLike = typeof fetch;

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
}

export function createApiClient(options: ApiClientOptions = {}) {
  const fetchImpl: FetchLike = options.fetch ?? ((...args) => fetch(...args));
  const base = () => options.baseUrl ?? apiBaseUrl();

  async function request(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
    // Outside the try: a missing or invalid NEXT_PUBLIC_API_URL is a
    // configuration bug and must fail loudly, not look like a network error.
    const url = `${base()}${path}`;
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      response = await fetchImpl(url, {
        ...rest,
        // Send and accept the session cookie. The API is another origin
        // (another port in dev, another subdomain in production).
        credentials: "include",
        // The caller's signal (to cancel) and the timeout both apply.
        signal: rest.signal ? AbortSignal.any([rest.signal, timeout]) : timeout,
      });
    } catch (error) {
      throw toTransportError(error);
    }
    if (!response.ok) throw await toApiError(response);
    return response;
  }

  async function json<T>(schema: z.ZodType<T>, response: Response): Promise<T> {
    const text = await readBody(() => response.text());
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        response.status,
        "invalid_response",
        "Unexpected response from the server.",
      );
    }
    return parsed.data;
  }

  const jsonBody = (body: unknown): RequestInit => ({
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    /** The signed-in user. Rejects with a 401 ApiError when signed out. */
    async me(): Promise<User> {
      return json(userSchema, await request("/auth/me"));
    },
    async providers(): Promise<Providers> {
      return json(providersSchema, await request("/auth/providers"));
    },
    /** Where to send the browser to sign in; it comes back to `next` (a path). */
    signInUrl(provider: ProviderName, next: string): string {
      return `${base()}/auth/${provider}/login?next=${encodeURIComponent(next)}`;
    },
    /** Development sign-in by name. The server only allows it when configured to. */
    async devLogin(name: string): Promise<User> {
      return json(
        userSchema,
        await request("/auth/dev-login", { method: "POST", ...jsonBody({ name }) }),
      );
    },
    async logout(): Promise<void> {
      await request("/auth/logout", { method: "POST" });
    },
    async listNotebooks(): Promise<Notebook[]> {
      return json(z.array(notebookSchema), await request("/notebooks"));
    },
    async createNotebook(title: string): Promise<Notebook> {
      return json(
        notebookSchema,
        await request("/notebooks", { method: "POST", ...jsonBody({ title }) }),
      );
    },
    async getNotebook(id: string): Promise<Notebook> {
      return json(notebookSchema, await request(`/notebooks/${encodeURIComponent(id)}`));
    },
    async renameNotebook(id: string, title: string): Promise<Notebook> {
      return json(
        notebookSchema,
        await request(`/notebooks/${encodeURIComponent(id)}`, {
          method: "PATCH",
          ...jsonBody({ title }),
        }),
      );
    },
    async deleteNotebook(id: string): Promise<void> {
      await request(`/notebooks/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    /**
     * Runs a cell. Aborting `signal` only stops waiting for the response: the
     * server keeps running the query (holding one of its workers) and stores
     * the run. So the UI never aborts to start another run; it aborts only
     * when the page goes away.
     *
     * If the cell is already running (someone else pressed Run), the server
     * doesn't run it again: it waits for that run and returns it (HTTP 200
     * instead of 201). Its SQL may differ from `sql`; the UI already marks a
     * result whose SQL differs from the editor's.
     */
    async runCell(
      notebookId: string,
      cellId: string,
      sql: string,
      signal?: AbortSignal,
    ): Promise<Run> {
      const path = `/notebooks/${encodeURIComponent(notebookId)}/cells/${encodeURIComponent(cellId)}/runs`;
      return json(
        runSchema,
        await request(path, {
          method: "POST",
          ...jsonBody({ sql }),
          timeoutMs: RUN_TIMEOUT_MS,
          signal,
        }),
      );
    },
    async getRun(notebookId: string, runId: string): Promise<Run> {
      const path = `/notebooks/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}`;
      return json(runSchema, await request(path));
    },
    /** Owner only. The returned token is shown once; the server keeps only its hash. */
    async createShareLink(notebookId: string, role: SharedRole): Promise<CreatedShareLink> {
      return json(
        createdShareLinkSchema,
        await request(`/notebooks/${encodeURIComponent(notebookId)}/share-links`, {
          method: "POST",
          ...jsonBody({ role }),
        }),
      );
    },
    async listShareLinks(notebookId: string): Promise<ShareLink[]> {
      return json(
        z.array(shareLinkSchema),
        await request(`/notebooks/${encodeURIComponent(notebookId)}/share-links`),
      );
    },
    async revokeShareLink(notebookId: string, linkId: string): Promise<void> {
      const path = `/notebooks/${encodeURIComponent(notebookId)}/share-links/${encodeURIComponent(linkId)}`;
      await request(path, { method: "DELETE" });
    },
    /** Joins a notebook through a share link's token. Never lowers an existing role. */
    async acceptShareLink(token: string): Promise<AcceptedShareLink> {
      return json(
        acceptedShareLinkSchema,
        await request("/share-links/accept", { method: "POST", ...jsonBody({ token }) }),
      );
    },
    async listMembers(notebookId: string): Promise<Member[]> {
      return json(
        z.array(memberSchema),
        await request(`/notebooks/${encodeURIComponent(notebookId)}/members`),
      );
    },
    async updateMember(notebookId: string, userId: string, role: SharedRole): Promise<Member> {
      const path = `/notebooks/${encodeURIComponent(notebookId)}/members/${encodeURIComponent(userId)}`;
      return json(memberSchema, await request(path, { method: "PATCH", ...jsonBody({ role }) }));
    },
    /** The owner removes someone, or a member removes themself (leaves). */
    async removeMember(notebookId: string, userId: string): Promise<void> {
      const path = `/notebooks/${encodeURIComponent(notebookId)}/members/${encodeURIComponent(userId)}`;
      await request(path, { method: "DELETE" });
    },
    /**
     * Asks the AI assistant to write, fix or explain a cell's SQL. Resolves
     * with the stored suggestion once it's done; meanwhile, and afterwards,
     * every member sees the request and its suggestion through the document.
     * Fails with kind "busy" (409 if the cell already has a request in
     * flight, 503 if the assistant is at capacity), "rate_limited" (429: too
     * many recent requests, or two already in flight), "unavailable" (503,
     * no AI configured), "ai_failed" (502: the assistant couldn't answer;
     * everyone sees the failure in the document) or "not_found" (404).
     * A new request replaces the cell's suggestion still awaiting a decision.
     * Aborting only stops waiting: the server finishes the request anyway.
     */
    async askAi(
      notebookId: string,
      cellId: string,
      body: AiRequest,
      signal?: AbortSignal,
    ): Promise<Suggestion> {
      const path = `/notebooks/${encodeURIComponent(notebookId)}/cells/${encodeURIComponent(cellId)}/ai`;
      return json(
        suggestionSchema,
        await request(path, {
          method: "POST",
          ...jsonBody(body),
          timeoutMs: AI_TIMEOUT_MS,
          signal,
        }),
      );
    },
    /** Records accepting or rejecting a pending suggestion (409 if it was already decided). */
    async decideSuggestion(
      notebookId: string,
      suggestionId: string,
      decision: Decision,
    ): Promise<Suggestion> {
      const path = `/notebooks/${encodeURIComponent(notebookId)}/ai/suggestions/${encodeURIComponent(suggestionId)}/decision`;
      return json(
        suggestionSchema,
        await request(path, { method: "POST", ...jsonBody({ decision }) }),
      );
    },
    /** A short-lived ticket for connecting to the sync server. */
    async syncTicket(notebookId: string): Promise<SyncTicket> {
      return json(
        syncTicketSchema,
        await request(`/notebooks/${encodeURIComponent(notebookId)}/sync-ticket`, {
          method: "POST",
        }),
      );
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * Maps a failure to send a request or read a response. Only transport
 * failures become ApiErrors; anything else is a bug and is rethrown as is.
 */
function toTransportError(error: unknown): unknown {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new ApiError(0, "timeout", "The server took too long to respond.");
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ApiError(0, "aborted", "The request was cancelled.");
  }
  if (error instanceof TypeError) {
    // fetch reports network failures (offline, refused, CORS) as TypeError.
    return new ApiError(0, "network", "Could not reach the server.");
  }
  return error;
}

async function readBody<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw toTransportError(error);
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const body = errorBodySchema.safeParse(await response.json().catch(() => undefined));
  if (body.success) {
    return new ApiError(response.status, body.data.detail.kind, body.data.detail.message);
  }
  return new ApiError(response.status, "http_error", `Request failed (HTTP ${response.status}).`);
}
