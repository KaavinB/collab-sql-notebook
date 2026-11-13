import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Creates and migrates the test database once per run.
    globalSetup: ["test/global-setup.ts"],
    // Integration tests share one database and truncate it between tests, so
    // files run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 120_000,
  },
});
