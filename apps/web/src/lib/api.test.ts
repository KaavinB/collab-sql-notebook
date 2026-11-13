import { describe, expect, it, vi } from "vitest";

import { ApiError, createApiClient } from "@/lib/api";

const BASE = "http://api.test";
const NOTEBOOK = {
  id: "4e7cec47-ee07-48e8-b7cd-3b878e00aa86",
  title: "Taxi",
  created_at: "2026-11-13T07:00:00Z",
  updated_at: "2026-11-13T07:00:00Z",
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
    const broken = (read: "text" | "arrayBuffer") => {
      const response = new Response("x");
      Object.defineProperty(response, read, {
        value: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      });
      return response;
    };
    const { api } = client(broken("text"), broken("arrayBuffer"));
    await expect(api.listNotebooks()).rejects.toMatchObject({ kind: "timeout" });
    await expect(api.loadSnapshot(NOTEBOOK.id)).rejects.toMatchObject({ kind: "timeout" });
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

  it("loads a missing snapshot as null and a saved one as bytes", async () => {
    const { api } = client(
      new Response(null, { status: 204 }),
      new Response(new Uint8Array([1, 2, 3])),
    );
    expect(await api.loadSnapshot(NOTEBOOK.id)).toBeNull();
    expect(await api.loadSnapshot(NOTEBOOK.id)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("saves a snapshot as raw bytes", async () => {
    const { api, fetchMock } = client(new Response(null, { status: 204 }));
    await api.saveSnapshot(NOTEBOOK.id, new Uint8Array([9]));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/notebooks/${NOTEBOOK.id}/snapshot`);
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/octet-stream");
    expect(init?.body).toEqual(new Uint8Array([9]));
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

  it("encodes path segments", async () => {
    const { api, fetchMock } = client(json(NOTEBOOK));
    await api.getNotebook("a/../b");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/notebooks/a%2F..%2Fb`);
  });
});
