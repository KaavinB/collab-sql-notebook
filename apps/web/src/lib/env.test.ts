import { describe, expect, it } from "vitest";

// Imported through the "@/" alias on purpose, to prove Vitest resolves it.
import { parseApiBaseUrl } from "@/lib/env";

describe("parseApiBaseUrl", () => {
  it("accepts an http URL and strips the trailing slash", () => {
    expect(parseApiBaseUrl("http://127.0.0.1:8000/")).toBe("http://127.0.0.1:8000");
  });

  it("keeps a path prefix", () => {
    expect(parseApiBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1");
  });

  it("rejects a missing value", () => {
    expect(() => parseApiBaseUrl(undefined)).toThrow(/not set/);
    expect(() => parseApiBaseUrl("")).toThrow(/not set/);
  });

  it("rejects a malformed URL", () => {
    expect(() => parseApiBaseUrl("not a url")).toThrow(/not a valid URL/);
  });

  it("rejects non-http protocols", () => {
    expect(() => parseApiBaseUrl("javascript:alert(1)")).toThrow(/must be http/);
    expect(() => parseApiBaseUrl("ws://127.0.0.1:8000")).toThrow(/must be http/);
  });

  it("rejects credentials, query strings and fragments", () => {
    for (const bad of [
      "http://user:pass@127.0.0.1:8000",
      "http://user@127.0.0.1:8000",
      "http://127.0.0.1:8000/?x=1",
      "http://127.0.0.1:8000/#frag",
    ]) {
      expect(() => parseApiBaseUrl(bad)).toThrow(/must not contain/);
    }
  });
});
