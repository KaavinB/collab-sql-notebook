import { describe, expect, it, vi } from "vitest";

import { ApiError, createApiClient } from "@/lib/api";

const BASE = "http://api.test";
const NOTEBOOK = {
  id: "4e7cec47-ee07-48e8-b7cd-3b878e00aa86",
  title: "Taxi",
  created_at: "2026-11-13T07:00:00Z",
  updated_at: "2026-11-13T07:00:00Z",
  role: "owner",
};

function client(...responses: (Response | Error)[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const r of responses) {
    if (r instanceof Error) fetchMock.mockRejectedValueOnce(r);
    else fetchMock.mockResolvedValueOnce(r);
  }
  return { api: createApiClient({ baseUrl: BASE, fetch: fetchMock }), fetchMock };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("api client", () => {
  it("sends the session cookie with every request", async () => {
    const { api, fetchMock } = client(json([NOTEBOOK]));
    await api.listNotebooks();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "include" });
  });

  it("reports a missing session as a 401 ApiError", async () => {
    const { api } = client(
      json({ detail: { kind: "unauthenticated", message: "Please sign in." } }, 401),
    );
    await expect(api.me()).rejects.toMatchObject({ status: 401, kind: "unauthenticated" });
  });

  it("builds a sign-in URL that comes back to the given path", () => {
    const { api } = client();
    expect(api.signInUrl("github", "/notebooks/a b")).toBe(
      `${BASE}/auth/github/login?next=%2Fnotebooks%2Fa%20b`,
    );
  });

  it("rejects a notebook without a known role", async () => {
    const { api } = client(json([{ ...NOTEBOOK, role: "admin" }]));
    await expect(api.listNotebooks()).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("lists notebooks and validates them", async () => {
    const { api, fetchMock } = client(json([NOTEBOOK]));
    expect(await api.listNotebooks()).toEqual([NOTEBOOK]);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/notebooks`);
  });

  it("rejects a response that doesn't match the schema", async () => {
    const { api } = client(json([{ ...NOTEBOOK, id: "not-a-uuid" }]));
    await expect(api.listNotebooks()).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("turns the API's error body into an ApiError", async () => {
    const { api } = client(
      json({ detail: { kind: "not_found", message: "Notebook not found." } }, 404),
    );
    const error = await api.getNotebook(NOTEBOOK.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, kind: "not_found", message: "Notebook not found." });
  });

  it("handles errors without a JSON body", async () => {
    const { api } = client(new Response("bad gateway", { status: 502 }));
    await expect(api.listNotebooks()).rejects.toMatchObject({ status: 502, kind: "http_error" });
  });

  it("reports network failures, timeouts and cancellation", async () => {
    const { api } = client(
      new TypeError("fetch failed"),
      new DOMException("signal timed out", "TimeoutError"),
      new DOMException("aborted", "AbortError"),
    );
    await expect(api.listNotebooks()).rejects.toMatchObject({ kind: "network" });
    await expect(api.listNotebooks()).rejects.toMatchObject({ kind: "timeout" });
    await expect(api.listNotebooks()).rejects.toMatchObject({ kind: "aborted" });
  });

  it("does not disguise a bug as a network error", async () => {
    const { api } = client(new RangeError("bug in our code"));
    await expect(api.listNotebooks()).rejects.toBeInstanceOf(RangeError);
  });

  it("fails loudly when the API URL is not configured", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const api = createApiClient({ fetch: fetchMock }); // falls back to NEXT_PUBLIC_API_URL
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    try {
      await expect(api.listNotebooks()).rejects.toThrow(/NEXT_PUBLIC_API_URL is not set/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("maps a failure while reading the body like a transport failure", async () => {
    const response = new Response("x");
    Object.defineProperty(response, "text", {
      value: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    });
    const { api } = client(response);
    await expect(api.listNotebooks()).rejects.toMatchObject({ kind: "timeout" });
  });

  it("rejects a run whose status doesn't match its result", async () => {
    const { api } = client(
      json(
        {
          id: "748e72ab-e87e-4182-9106-f09d48615e34",
          cell_id: "c1",
          sql: "select 1",
          status: "ok",
          result: null,
          error: null,
          created_at: "2026-11-13T07:00:00Z",
        },
        201,
      ),
    );
    await expect(api.runCell(NOTEBOOK.id, "c1", "select 1")).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("runs a cell and validates the stored run", async () => {
    const run = {
      id: "748e72ab-e87e-4182-9106-f09d48615e34",
      cell_id: "cell-1",
      sql: "select 1",
      status: "ok",
      result: {
        columns: [{ name: "x", type: "INTEGER" }],
        rows: [[1]],
        row_count: 1,
        truncated: false,
        duration_ms: 1.5,
      },
      error: null,
      created_at: "2026-11-13T07:00:00Z",
    };
    const { api, fetchMock } = client(json(run, 201));
    expect(await api.runCell(NOTEBOOK.id, "cell-1", "select 1")).toEqual(run);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/notebooks/${NOTEBOOK.id}/cells/cell-1/runs`);
    expect(JSON.parse(init?.body as string)).toEqual({ sql: "select 1" });
  });

  it("accepts a joined run (200) exactly like a fresh one (201)", async () => {
    const run = {
      id: "748e72ab-e87e-4182-9106-f09d48615e34",
      cell_id: "cell-1",
      sql: "select 'someone else''s edit'",
      status: "error",
      result: null,
      error: { kind: "error", message: "Binder Error" },
      created_at: "2026-11-13T07:00:00Z",
    };
    const { api } = client(json(run, 200));
    expect(await api.runCell(NOTEBOOK.id, "cell-1", "select 1")).toEqual(run);
  });

  describe("sharing", () => {
    const LINK = {
      id: "2b1f8a52-8a8e-4f43-9e0e-5d2f7f0c1a11",
      role: "editor",
      created_at: "2026-11-13T07:00:00Z",
    };
    const TOKEN = "q3Jb2xk9V0yZ7cR1mN5pT8wL4hF6dS2aE0uI9oK3jG7";
    const MEMBER = {
      user_id: "0b0f3c50-61c4-4b2a-9d39-5d1f2a7f3e10",
      name: "Ada",
      role: "viewer",
    };

    it("creates a link and returns its token", async () => {
      const { api, fetchMock } = client(json({ ...LINK, token: TOKEN }, 201));
      expect(await api.createShareLink(NOTEBOOK.id, "editor")).toEqual({ ...LINK, token: TOKEN });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE}/notebooks/${NOTEBOOK.id}/share-links`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ role: "editor" });
    });

    it("rejects a created link without a usable token", async () => {
      const { api } = client(json({ ...LINK, token: "has spaces in it, not a token" }, 201));
      await expect(api.createShareLink(NOTEBOOK.id, "editor")).rejects.toMatchObject({
        kind: "invalid_response",
      });
    });

    it("lists and revokes links", async () => {
      const { api, fetchMock } = client(json([LINK]), new Response(null, { status: 204 }));
      expect(await api.listShareLinks(NOTEBOOK.id)).toEqual([LINK]);
      await api.revokeShareLink(NOTEBOOK.id, LINK.id);
      expect(fetchMock.mock.calls[1][0]).toBe(
        `${BASE}/notebooks/${NOTEBOOK.id}/share-links/${LINK.id}`,
      );
      expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
    });

    it("never accepts an owner link from the server", async () => {
      const { api } = client(json([{ ...LINK, role: "owner" }]));
      await expect(api.listShareLinks(NOTEBOOK.id)).rejects.toMatchObject({
        kind: "invalid_response",
      });
    });

    it("accepts a link by its token", async () => {
      const accepted = { notebook_id: NOTEBOOK.id, role: "editor" };
      const { api, fetchMock } = client(json(accepted));
      expect(await api.acceptShareLink(TOKEN)).toEqual(accepted);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE}/share-links/accept`);
      expect(JSON.parse(init?.body as string)).toEqual({ token: TOKEN });
    });

    it("lists, re-roles and removes members", async () => {
      const { api, fetchMock } = client(
        json([MEMBER]),
        json({ ...MEMBER, role: "editor" }),
        new Response(null, { status: 204 }),
      );
      expect(await api.listMembers(NOTEBOOK.id)).toEqual([MEMBER]);
      expect(await api.updateMember(NOTEBOOK.id, MEMBER.user_id, "editor")).toEqual({
        ...MEMBER,
        role: "editor",
      });
      await api.removeMember(NOTEBOOK.id, MEMBER.user_id);
      const memberUrl = `${BASE}/notebooks/${NOTEBOOK.id}/members/${MEMBER.user_id}`;
      expect(fetchMock.mock.calls[1][0]).toBe(memberUrl);
      expect(fetchMock.mock.calls[1][1]?.method).toBe("PATCH");
      expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({ role: "editor" });
      expect(fetchMock.mock.calls[2][0]).toBe(memberUrl);
      expect(fetchMock.mock.calls[2][1]?.method).toBe("DELETE");
    });

    it("gets a sync ticket", async () => {
      const ticket = { ticket: "abc.def", url: "ws://localhost:8020", role: "viewer" };
      const { api, fetchMock } = client(json(ticket));
      expect(await api.syncTicket(NOTEBOOK.id)).toEqual(ticket);
      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/notebooks/${NOTEBOOK.id}/sync-ticket`);
      expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    });

    it.each(["http://localhost:8020", "javascript:alert(1)", "ws://"])(
      "refuses a sync URL that isn't a WebSocket URL (%s)",
      async (url) => {
        const { api } = client(json({ ticket: "abc.def", url, role: "viewer" }));
        await expect(api.syncTicket(NOTEBOOK.id)).rejects.toMatchObject({
          kind: "invalid_response",
        });
      },
    );
  });

  it("encodes path segments", async () => {
    const { api, fetchMock } = client(json(NOTEBOOK));
    await api.getNotebook("a/../b");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/notebooks/a%2F..%2Fb`);
  });
});
