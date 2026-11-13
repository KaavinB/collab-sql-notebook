import { describe, expect, it } from "vitest";

import { settlePendingWork, trackPendingWork } from "@/lib/pendingWork";
import { deferred } from "@/test/fakeApi";

describe("pending work", () => {
  it("waits for tracked work, including work added while waiting, and survives failures", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    trackPendingWork(first.promise);
    let settled = false;
    const done = settlePendingWork().then(() => (settled = true));
    trackPendingWork(second.promise);
    first.reject(new Error("save failed"));
    await Promise.resolve();
    expect(settled).toBe(false);
    second.resolve();
    await done;
    expect(settled).toBe(true);
  });

  it("resolves at once when nothing is pending", async () => {
    await expect(settlePendingWork()).resolves.toBeUndefined();
  });
});
