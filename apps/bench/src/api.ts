/**
 * The few API calls the benchmarks need, made the way the web app makes them:
 * a session cookie from the dev sign-in, and the web app's Origin on every
 * state-changing request. Load clients get real sync tickets this way, so
 * the sync server checks them exactly as it checks a browser's.
 */

export interface SyncTicket {
  ticket: string;
  url: string;
  role: string;
}

const TIMEOUT_MS = 15_000;

/** The API's cap on members per notebook (services/api notebooks/sharing.py), owner included. */
export const MEMBERS_LIMIT = 500;

export class ApiError extends Error {}

export class ApiSession {
  private cookie = "";
  userId = "";
  readonly apiUrl: string;
  readonly webOrigin: string;
  readonly name: string;

  constructor(apiUrl: string, webOrigin: string, name: string) {
    this.apiUrl = apiUrl;
    this.webOrigin = webOrigin;
    this.name = name;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { Origin: this.webOrigin };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
      // Only name=value matters to the server; attributes are for browsers.
      this.cookie = cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
    }
    if (!response.ok) {
      // The API's error bodies never echo secrets, but keep the message short.
      const text = (await response.text()).slice(0, 300);
      throw new ApiError(`${method} ${path} answered ${response.status}: ${text}`);
    }
    return response.status === 204 ? null : response.json();
  }

  async signIn(): Promise<void> {
    const user = (await this.call("POST", "/auth/dev-login", { name: this.name })) as {
      id: string;
    };
    this.userId = user.id;
  }

  async createNotebook(title: string): Promise<string> {
    return ((await this.call("POST", "/notebooks", { title })) as { id: string }).id;
  }

  async deleteNotebook(notebookId: string): Promise<void> {
    await this.call("DELETE", `/notebooks/${notebookId}`);
  }

  async shareLink(notebookId: string, role: "editor" | "viewer"): Promise<string> {
    const link = (await this.call("POST", `/notebooks/${notebookId}/share-links`, { role })) as {
      token: string;
    };
    return link.token;
  }

  async acceptShareLink(token: string): Promise<void> {
    await this.call("POST", "/share-links/accept", { token });
  }

  async syncTicket(notebookId: string): Promise<SyncTicket> {
    const ticket = (await this.call("POST", `/notebooks/${notebookId}/sync-ticket`)) as SyncTicket;
    if (typeof ticket.ticket !== "string" || typeof ticket.url !== "string") {
      throw new ApiError("sync-ticket answered an unexpected shape");
    }
    return ticket;
  }
}

/** Runs `task` over `items` with at most `limit` running at once, in order of results. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
