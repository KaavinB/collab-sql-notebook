import { defineConfig } from "vitest/config";

// Unit tests only: the statistics, sample bookkeeping and report logic. The
// benchmarks themselves (pnpm bench:latency, pnpm bench:load) start servers
// and browsers and are never part of `pnpm test` or `pnpm check`.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
