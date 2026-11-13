import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";
import { isPermanentSaveError, saveLabel } from "@/lib/notebook/saveStatus";

describe("isPermanentSaveError", () => {
  it.each([400, 404, 413, 422])("treats %i as permanent", (status) => {
    expect(isPermanentSaveError(new ApiError(status, "x", "x"))).toBe(true);
  });

  it.each([0, 408, 429, 500, 502, 503])("retries %i", (status) => {
    expect(isPermanentSaveError(new ApiError(status, "x", "x"))).toBe(false);
  });

  it("retries errors that aren't API errors", () => {
    expect(isPermanentSaveError(new Error("boom"))).toBe(false);
  });
});

describe("saveLabel", () => {
  it("says it is retrying only when it is", () => {
    const transient = new ApiError(503, "busy", "busy");
    const gone = new ApiError(404, "not_found", "Notebook not found.");
    expect(saveLabel({ status: "error", error: transient, permanent: false })).toBe(
      "Not saved — retrying",
    );
    expect(saveLabel({ status: "error", error: gone, permanent: true })).toBe(
      "Not saved: Notebook not found.",
    );
    expect(saveLabel({ status: "saved" })).toBe("Saved");
    expect(saveLabel({ status: "pending" })).toBe("Unsaved changes");
  });
});
