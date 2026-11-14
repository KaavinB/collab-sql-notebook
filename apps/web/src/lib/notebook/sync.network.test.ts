// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { connectNotebook, type NotebookSync } from "@/lib/notebook/sync";
import { fakeApi, NOTEBOOK } from "@/test/fakeApi";
import { fakeProviders } from "@/test/fakeSync";

let open: NotebookSync[] = [];
afterEach(() => {
  open.forEach((sync) => sync.destroy());
  open = [];
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function live() {
  const providers = fakeProviders();
  const sync = connectNotebook(fakeApi(), NOTEBOOK.id, providers.factory);
  open.push(sync);
  await flush();
  providers.latest().serve();
  return { sync, provider: providers.latest() };
}

describe("the browser's online and offline events", () => {
  it("going offline drops the socket at once instead of waiting for the watchdog", async () => {
    const { provider } = await live();
    window.dispatchEvent(new Event("offline"));
    expect(provider.disconnects).toBe(1);
    expect(provider.connects).toBe(1); // keeps trying; succeeds once back online
  });

  it("coming back online reconnects at once", async () => {
    const { sync, provider } = await live();
    provider.drop();
    expect(sync.get().status).toBe("offline");
    window.dispatchEvent(new Event("online"));
    expect(provider.disconnects).toBe(1);
    expect(provider.connects).toBe(1);
  });

  it("leaves a stopped connection alone", async () => {
    const { sync, provider } = await live();
    provider.close(4404);
    await flush();
    expect(sync.get().status).toBe("stopped");
    const before = { connects: provider.connects, disconnects: provider.disconnects };
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("offline"));
    expect({ connects: provider.connects, disconnects: provider.disconnects }).toEqual(before);
  });

  it("stops listening once destroyed", async () => {
    const { sync, provider } = await live();
    sync.destroy();
    window.dispatchEvent(new Event("offline"));
    expect(provider.disconnects).toBe(0);
  });
});
