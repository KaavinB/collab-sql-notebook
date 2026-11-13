import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadEnvFile } from "@/lib/load-env-file";

function tempEnvFile(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "env-test-"));
  const file = path.join(dir, ".env");
  writeFileSync(file, contents);
  return file;
}

describe("loadEnvFile", () => {
  it("loads variables from the file", () => {
    const env: Record<string, string | undefined> = {};
    const file = tempEnvFile("NEXT_PUBLIC_API_URL=http://127.0.0.1:8000\n# comment\nOTHER=x\n");
    expect(loadEnvFile(file, env)).toEqual(["NEXT_PUBLIC_API_URL", "OTHER"]);
    expect(env.NEXT_PUBLIC_API_URL).toBe("http://127.0.0.1:8000");
  });

  it("never overrides a variable that is already set", () => {
    const env: Record<string, string | undefined> = { NEXT_PUBLIC_API_URL: "https://real.example" };
    const file = tempEnvFile("NEXT_PUBLIC_API_URL=http://127.0.0.1:8000\n");
    expect(loadEnvFile(file, env)).toEqual([]);
    expect(env.NEXT_PUBLIC_API_URL).toBe("https://real.example");
  });

  it("does nothing when the file does not exist", () => {
    const env: Record<string, string | undefined> = {};
    expect(loadEnvFile("/definitely/not/here/.env", env)).toEqual([]);
    expect(env).toEqual({});
  });
});
