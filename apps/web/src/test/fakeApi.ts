import { vi } from "vitest";

import type { ApiClient, Notebook, Run, User } from "@/lib/api";

export const NOTEBOOK: Notebook = {
  id: "4e7cec47-ee07-48e8-b7cd-3b878e00aa86",
  title: "Taxi",
  created_at: "2026-11-13T07:00:00Z",
  updated_at: "2026-11-13T07:00:00Z",
  role: "owner",
};

export const USER: User = { id: "0b0f3c50-61c4-4b2a-9d39-5d1f2a7f3e10", name: "Ada" };

/** A share link token, shaped like the API's (43 base64url characters). */
export const SHARE_TOKEN = "q3Jb2xk9V0yZ7cR1mN5pT8wL4hF6dS2aE0uI9oK3jG7";

export function okRun(id: string, value: unknown, cellId = "c1"): Run {
  return {
    id,
    cell_id: cellId,
    sql: "select 1",
    status: "ok",
    result: {
      columns: [{ name: "x", type: "INTEGER" }],
      rows: [[value]],
      row_count: 1,
      truncated: false,
      duration_ms: 1,
    },
    error: null,
    created_at: "2026-11-13T07:00:00Z",
  };
}

/** An ApiClient whose every method is a vi.fn, with harmless defaults. */
export function fakeApi(overrides: Partial<ApiClient> = {}) {
  const api = {
    me: vi.fn<ApiClient["me"]>(async () => USER),
    providers: vi.fn<ApiClient["providers"]>(async () => ({ providers: [], dev_login: true })),
    signInUrl: vi.fn<ApiClient["signInUrl"]>(
      (provider, next) => `http://api.test/auth/${provider}/login?next=${encodeURIComponent(next)}`,
    ),
    devLogin: vi.fn<ApiClient["devLogin"]>(async () => USER),
    logout: vi.fn<ApiClient["logout"]>(async () => {}),
    listNotebooks: vi.fn<ApiClient["listNotebooks"]>(async () => [NOTEBOOK]),
    createNotebook: vi.fn<ApiClient["createNotebook"]>(async () => NOTEBOOK),
    getNotebook: vi.fn<ApiClient["getNotebook"]>(async () => NOTEBOOK),
    renameNotebook: vi.fn<ApiClient["renameNotebook"]>(async (_id, title) => ({
      ...NOTEBOOK,
      title,
    })),
    deleteNotebook: vi.fn<ApiClient["deleteNotebook"]>(async () => {}),
    runCell: vi.fn<ApiClient["runCell"]>(async () => okRun("r1", 1)),
    getRun: vi.fn<ApiClient["getRun"]>(async (_nb, id) => okRun(id, 1)),
    createShareLink: vi.fn<ApiClient["createShareLink"]>(async (_nb, role) => ({
      id: "2b1f8a52-8a8e-4f43-9e0e-5d2f7f0c1a11",
      role,
      created_at: "2026-11-13T07:00:00Z",
      token: SHARE_TOKEN,
    })),
    listShareLinks: vi.fn<ApiClient["listShareLinks"]>(async () => []),
    revokeShareLink: vi.fn<ApiClient["revokeShareLink"]>(async () => {}),
    acceptShareLink: vi.fn<ApiClient["acceptShareLink"]>(async () => ({
      notebook_id: NOTEBOOK.id,
      role: "editor",
    })),
    listMembers: vi.fn<ApiClient["listMembers"]>(async () => [
      { user_id: USER.id, name: USER.name, role: "owner" },
    ]),
    updateMember: vi.fn<ApiClient["updateMember"]>(async (_nb, userId, role) => ({
      user_id: userId,
      name: "Someone",
      role,
    })),
    removeMember: vi.fn<ApiClient["removeMember"]>(async () => {}),
    syncTicket: vi.fn<ApiClient["syncTicket"]>(async () => ({
      ticket: "ticket",
      url: "ws://localhost:8020",
      role: "owner",
    })),
    ...overrides,
  };
  return api satisfies ApiClient;
}

/** A promise you resolve or reject from outside. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
