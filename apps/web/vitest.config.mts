import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror the "@/*" path alias from tsconfig.json.
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // e2e/ holds Playwright tests, run with `pnpm e2e`.
    // Pure-logic tests by default; component tests opt into jsdom per file.
    environment: "node",
  },
});
