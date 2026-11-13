import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnvFile } from "@/lib/load-env-file";

const tempDirs: string[] = [];

function tempEnvFile(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "env-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, ".env");
  writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

  it("throws on read errors other than a missing file", () => {
    const dir = path.dirname(tempEnvFile(""));
    // Reading a directory fails with EISDIR, which must not be swallowed.
    expect(() => loadEnvFile(dir, {})).toThrow(/EISDIR/);
  });
});
