import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { attachAutosave, LOAD_ORIGIN, type SaveStatus } from "@/lib/notebook/autosave";

function setup(save: (state: Uint8Array) => Promise<void>) {
  const doc = new Y.Doc();
  const statuses: SaveStatus[] = [];
  const autosave = attachAutosave(doc, {
    save,
    debounceMs: 500,
    onStatus: (s) => statuses.push(s),
  });
  const type = (text: string) => doc.getText("t").insert(0, text);
  return { doc, autosave, statuses, type };
}

describe("autosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves once after edits stop, with the latest state", async () => {
    const save = vi.fn<(state: Uint8Array) => Promise<void>>(async () => {});
    const { doc, type, statuses } = setup(save);
    type("a");
    await vi.advanceTimersByTimeAsync(300);
    type("b");
    await vi.advanceTimersByTimeAsync(300);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(1);
    const saved = new Y.Doc();
    Y.applyUpdate(saved, save.mock.calls[0][0]);
    expect(saved.getText("t").toString()).toBe(doc.getText("t").toString());
    expect(statuses.at(-1)).toBe("saved");
  });

  it("does not save changes that came from loading the snapshot", async () => {
    const save = vi.fn(async () => {});
    const { doc } = setup(save);
    doc.transact(() => doc.getText("t").insert(0, "loaded"), LOAD_ORIGIN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
  });

  it("never overlaps saves, and saves again if edits arrive mid-save", async () => {
    let active = 0;
    let maxActive = 0;
    const save = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      active--;
    });
    const { type, autosave } = setup(save);
    type("a");
    await vi.advanceTimersByTimeAsync(600); // first save starts
    type("b");
    await vi.advanceTimersByTimeAsync(600); // debounce fires while saving
    await vi.advanceTimersByTimeAsync(3000);
    await autosave.flush();
    expect(maxActive).toBe(1);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("retries a failed save with backoff without any further edits", async () => {
    const save = vi
      .fn<(state: Uint8Array) => Promise<void>>()
      .mockRejectedValueOnce(new Error("api restarting"))
      .mockRejectedValueOnce(new Error("api restarting"))
      .mockResolvedValue(undefined);
    const { type, statuses } = setup(save);
    type("a");
    await vi.advanceTimersByTimeAsync(500); // t=500: debounced save fails
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999); // first retry is due 1 s later
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // t=1500: retry fails
    expect(save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999); // the next retry waits 2 s
    expect(save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // t=3500: retry succeeds
    expect(save).toHaveBeenCalledTimes(3);
    expect(statuses.at(-1)).toBe("saved");
  });

  it("flush rejects while the latest state can't be saved", async () => {
    const save = vi.fn<(state: Uint8Array) => Promise<void>>().mockRejectedValue(new Error("down"));
    const { type, autosave } = setup(save);
    type("a");
    await expect(autosave.flush()).rejects.toThrow("down");
    autosave.dispose();
  });

  it("reports errors and retries on flush", async () => {
    const save = vi
      .fn<(state: Uint8Array) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"));
    save.mockResolvedValue(undefined);
    const { type, autosave, statuses } = setup(save);
    type("a");
    await vi.advanceTimersByTimeAsync(600);
    expect(statuses).toContain("error");
    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe("saved");
  });

  it("flush saves pending edits immediately", async () => {
    const save = vi.fn(async () => {});
    const { type, autosave } = setup(save);
    type("a");
    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("stops listening after dispose", async () => {
    const save = vi.fn(async () => {});
    const { type, autosave } = setup(save);
    autosave.dispose();
    type("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
  });
});
