// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIRMATION_TIMINGS } from "@/lib/notebook/confirmations";

import {
  closeConnection,
  discardAllConnections,
  hasUnsyncedEdits,
  openConnection,
  resetConnections,
} from "@/lib/notebook/connections";
import { appendCell, orderedCells } from "@/lib/notebook/doc";
import { fakeApi, NOTEBOOK } from "@/test/fakeApi";
import { fakeProviders } from "@/test/fakeSync";

afterEach(resetConnections);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An open connection that went offline after loading, with one edit made offline. */
async function offlineWithAnEdit() {
  const providers = fakeProviders();
  const sync = openConnection(fakeApi(), NOTEBOOK.id, providers.factory);
  await flush();
  const provider = providers.latest();
  provider.serve();
  provider.drop();
  appendCell(sync.doc, "sql", "offline-cell");
  return { sync, provider, providers };
}

describe("notebook connections", () => {
  it("closes a connection with nothing unsynced at once", async () => {
    const providers = fakeProviders();
    const sync = openConnection(fakeApi(), NOTEBOOK.id, providers.factory);
    await flush();
    providers.latest().serve();
    closeConnection(NOTEBOOK.id, sync);
    expect(providers.latest().destroyed).toBe(true);
  });

  it("keeps a connection with offline edits until the server has them", async () => {
    const { sync, provider } = await offlineWithAnEdit();
    expect(hasUnsyncedEdits()).toBe(true);
    closeConnection(NOTEBOOK.id, sync); // the page went away
    expect(provider.destroyed).toBe(false);
    expect(hasUnsyncedEdits()).toBe(true);
    provider.serve(); // reconnected and synced
    expect(provider.destroyed).toBe(true);
    expect(hasUnsyncedEdits()).toBe(false);
  });

  it("hands the kept connection, edits included, to the page when it's reopened", async () => {
    const { sync, providers } = await offlineWithAnEdit();
    closeConnection(NOTEBOOK.id, sync);
    const reopened = openConnection(fakeApi(), NOTEBOOK.id, providers.factory);
    expect(reopened).toBe(sync);
    expect(providers.created).toHaveLength(1); // no second connection
    expect(orderedCells(reopened.doc).map((c) => c.id)).toEqual(["offline-cell"]);
    providers.latest().serve();
    expect(providers.latest().destroyed).toBe(false); // the page owns it again
  });

  it("lets go of a kept connection that can never sync", async () => {
    const { sync, provider } = await offlineWithAnEdit();
    closeConnection(NOTEBOOK.id, sync);
    provider.close(4404); // the notebook was deleted meanwhile
    await flush();
    expect(provider.destroyed).toBe(true);
    expect(hasUnsyncedEdits()).toBe(false);
  });

  it("asks the browser to confirm closing the tab while edits are unsynced", async () => {
    await offlineWithAnEdit();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    resetConnections();
    const calm = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(calm);
    expect(calm.defaultPrevented).toBe(false);
  });

  it("keeps a connection until the server confirms edits sent just before the page went away", async () => {
    const providers = fakeProviders();
    const sync = openConnection(fakeApi(), NOTEBOOK.id, providers.factory);
    await flush();
    const provider = providers.latest();
    provider.serve();
    appendCell(sync.doc, "sql"); // sent on the live connection, not confirmed yet
    closeConnection(NOTEBOOK.id, sync);
    expect(provider.destroyed).toBe(false);
    // Not at risk: a healthy connection delivers it, so closing the tab isn't blocked.
    expect(hasUnsyncedEdits()).toBe(false);
    provider.serve(); // the server confirms
    expect(provider.destroyed).toBe(true);
  });

  it("guards closing the tab when sent edits go unconfirmed (a dead connection)", async () => {
    vi.useFakeTimers();
    try {
      const providers = fakeProviders();
      const sync = openConnection(fakeApi(), NOTEBOOK.id, providers.factory);
      await vi.advanceTimersByTimeAsync(0);
      providers.latest().serve();
      appendCell(sync.doc, "sql");
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIRMATION_TIMINGS.overdueMs);
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discarding (sign-out) leaves nothing behind, even for a page that unmounts afterwards", async () => {
    const { sync, providers } = await offlineWithAnEdit();
    discardAllConnections(); // signing out
    closeConnection(NOTEBOOK.id, sync); // then the page unmounts
    expect(providers.latest().destroyed).toBe(true);
    expect(hasUnsyncedEdits()).toBe(false);
    // Reopening starts a fresh connection, not the discarded one.
    const reopened = openConnection(fakeApi(), NOTEBOOK.id, providers.factory);
    expect(reopened).not.toBe(sync);
    await flush(); // the provider is created once the ticket arrives
    expect(providers.created).toHaveLength(2);
  });
});
