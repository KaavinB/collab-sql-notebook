import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { ApiError, type ApiClient } from "@/lib/api";
import { appendCell, orderedCells } from "@/lib/notebook/doc";
import { connectNotebook, type NotebookSync } from "@/lib/notebook/sync";
import { fakeApi, NOTEBOOK } from "@/test/fakeApi";
import { fakeProviders } from "@/test/fakeSync";
import { ticketFor } from "@/test/tickets";

const token = (user: string, nonce = "t1") => ticketFor(user, nonce);
const ticket = (role: "owner" | "editor" | "viewer" = "editor", value = token("user-a")) => ({
  ticket: value,
  url: "ws://sync.test",
  role,
});

let open: NotebookSync[] = [];
function connect(api: ReturnType<typeof fakeApi>) {
  const providers = fakeProviders();
  const sync = connectNotebook(api, NOTEBOOK.id, providers.factory);
  open.push(sync);
  return { sync, providers };
}

afterEach(() => {
  open.forEach((sync) => sync.destroy());
  open = [];
  vi.useRealTimers();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function storedDoc(): Uint8Array {
  const doc = new Y.Doc();
  appendCell(doc, "sql", "stored");
  return Y.encodeStateAsUpdate(doc);
}

describe("connectNotebook", () => {
  it("connects with a ticket and goes live once the server's document arrives", async () => {
    const api = fakeApi({ syncTicket: vi.fn<ApiClient["syncTicket"]>(async () => ticket()) });
    const { sync, providers } = connect(api);
    await flush();
    const provider = providers.latest();
    expect(provider.serverUrl).toBe("ws://sync.test/notebooks");
    expect(provider.room).toBe(NOTEBOOK.id);
    expect(provider.params).toEqual({ ticket: token("user-a") });
    expect(sync.get()).toEqual({ status: "connecting", role: "editor" });

    provider.serve(storedDoc());
    expect(sync.get()).toEqual({ status: "live", role: "editor" });
    expect(orderedCells(sync.doc).map((c) => c.id)).toEqual(["stored"]);
  });

  it("goes offline on a dropped connection and counts edits made meanwhile", async () => {
    const { sync, providers } = connect(fakeApi());
    await flush();
    providers.latest().serve();
    expect(sync.hasUnsyncedEdits()).toBe(false);
    providers.latest().drop();
    expect(sync.get().status).toBe("offline");
    appendCell(sync.doc, "sql");
    expect(sync.hasUnsyncedEdits()).toBe(true);
    providers.latest().serve();
    expect(sync.get().status).toBe("live");
    expect(sync.hasUnsyncedEdits()).toBe(false);
  });

  it("doesn't count collaborators' edits as unsynced", async () => {
    const { sync, providers } = connect(fakeApi());
    await flush();
    providers.latest().remote(storedDoc());
    expect(sync.hasUnsyncedEdits()).toBe(false);
  });

  it.each([4401, 4403])(
    "gets a new ticket and reconnects after close code %i, taking the new role",
    async (code) => {
      const syncTicket = vi
        .fn<ApiClient["syncTicket"]>()
        .mockResolvedValueOnce(ticket("editor", token("user-a", "t1")))
        .mockResolvedValueOnce(ticket("viewer", token("user-a", "t2")));
      const { sync, providers } = connect(fakeApi({ syncTicket }));
      await flush();
      const provider = providers.latest();
      provider.serve();
      provider.close(code);
      await flush();
      expect(syncTicket).toHaveBeenCalledTimes(2);
      expect(provider.params).toEqual({ ticket: token("user-a", "t2") });
      expect(provider.connects).toBe(1);
      expect(sync.get()).toEqual({ status: "offline", role: "viewer" });
      provider.serve();
      expect(sync.get()).toEqual({ status: "live", role: "viewer" });
    },
  );

  it.each([
    [new ApiError(403, "forbidden", "x"), "no-access"],
    [new ApiError(404, "not_found", "x"), "no-access"],
    [new ApiError(401, "unauthenticated", "x"), "signed-out"],
  ] as const)("stops when the API refuses a new ticket (%s)", async (error, reason) => {
    const syncTicket = vi
      .fn<ApiClient["syncTicket"]>()
      .mockResolvedValueOnce(ticket())
      .mockRejectedValueOnce(error);
    const { sync, providers } = connect(fakeApi({ syncTicket }));
    await flush();
    providers.latest().serve();
    providers.latest().close(4403);
    await flush();
    expect(sync.get()).toMatchObject({ status: "stopped", reason });
  });

  it.each([
    [4404, "deleted"],
    [4400, "rejected"],
    [4413, "rejected"],
  ] as const)("stops for good on close code %i", async (code, reason) => {
    const syncTicket = vi.fn<ApiClient["syncTicket"]>(async () => ticket());
    const { sync, providers } = connect(fakeApi({ syncTicket }));
    await flush();
    providers.latest().serve();
    providers.latest().close(code);
    await flush();
    expect(sync.get()).toMatchObject({ status: "stopped", reason });
    expect(syncTicket).toHaveBeenCalledTimes(1);
  });

  it("says so when live collaboration isn't configured", async () => {
    const syncTicket = vi.fn<ApiClient["syncTicket"]>(async () => {
      throw new ApiError(503, "unavailable", "Live collaboration is not configured.");
    });
    const { sync, providers } = connect(fakeApi({ syncTicket }));
    await flush();
    expect(sync.get()).toMatchObject({
      status: "stopped",
      reason: "unavailable",
      message: "Live collaboration is not configured.",
    });
    expect(providers.created).toHaveLength(0);
  });

  it("retries a ticket request that fails for a transient reason", async () => {
    vi.useFakeTimers();
    const syncTicket = vi
      .fn<ApiClient["syncTicket"]>()
      .mockRejectedValueOnce(new ApiError(0, "network", "Could not reach the server."))
      .mockResolvedValueOnce(ticket());
    const { sync, providers } = connect(fakeApi({ syncTicket }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(syncTicket).toHaveBeenCalledTimes(2);
    expect(providers.created).toHaveLength(1);
    expect(sync.get().status).toBe("connecting");
  });

  it("backs off when new tickets keep being refused", async () => {
    vi.useFakeTimers();
    const syncTicket = vi.fn<ApiClient["syncTicket"]>(async () => ticket());
    const { providers } = connect(fakeApi({ syncTicket }));
    await vi.advanceTimersByTimeAsync(0);
    const provider = providers.latest();
    provider.close(4401); // first refusal: reconnect at once
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.connects).toBe(1);
    provider.close(4401); // refused again: wait before trying
    await vi.advanceTimersByTimeAsync(500);
    expect(provider.connects).toBe(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(provider.connects).toBe(2);
    // Reaching sync resets it.
    provider.serve();
    provider.close(4401);
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.connects).toBe(3);
  });

  it("stops rather than continue as someone else who signed in meanwhile", async () => {
    const syncTicket = vi
      .fn<ApiClient["syncTicket"]>()
      .mockResolvedValueOnce(ticket("editor", token("user-a")))
      .mockResolvedValueOnce(ticket("editor", token("user-b")));
    const { sync, providers } = connect(fakeApi({ syncTicket }));
    await flush();
    const provider = providers.latest();
    provider.serve();
    provider.close(4401);
    await flush();
    expect(sync.get()).toMatchObject({ status: "stopped", reason: "signed-out" });
    expect(provider.connects).toBe(0);
    expect(provider.params).toEqual({ ticket: token("user-a") });
  });

  it("fails closed when its first ticket can't be read", async () => {
    // Without a readable owner, no later ticket can be shown to be ours.
    const syncTicket = vi
      .fn<ApiClient["syncTicket"]>()
      .mockResolvedValueOnce(ticket("editor", "unreadable"))
      .mockResolvedValueOnce(ticket("editor", token("user-a")));
    const { sync, providers } = connect(fakeApi({ syncTicket }));
    await flush();
    providers.latest().serve();
    providers.latest().close(4401);
    await flush();
    expect(sync.get()).toMatchObject({ status: "stopped", reason: "signed-out" });
  });

  it("destroys the provider and stops notifying when destroyed", async () => {
    const { sync, providers } = connect(fakeApi());
    await flush();
    const listener = vi.fn();
    sync.subscribe(listener);
    sync.destroy();
    providers.latest().serve();
    expect(providers.latest().destroyed).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });
});
