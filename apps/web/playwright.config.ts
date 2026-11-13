import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests against the real stack: Postgres (`docker compose up -d`),
 * the taxi DuckDB file (`pnpm ingest`), the API and a production build of the
 * web app. Not part of `pnpm check`, which must run without those. Run with
 * `pnpm e2e`.
 *
 * The tests start their own API and web servers on their own ports, from the
 * current code, and never reuse a running server: a dev server on :3000 or an
 * old build would otherwise be tested by mistake. The web app is a production
 * build (not `next dev`, which compiles routes on first visit and made timing
 * flaky) in its own build directory.
 */
const WEB_PORT = 3100;
const API_PORT = 8100;
const WEB_URL = `http://localhost:${WEB_PORT}`;
const API_URL = `http://127.0.0.1:${API_PORT}`;

// Read by the specs (Playwright workers inherit this process's environment).
process.env.E2E_API_URL = API_URL;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: WEB_URL, trace: "retain-on-failure" },
  webServer: [
    {
      command: "pnpm --dir ../.. dev:api",
      url: `${API_URL}/health`,
      // Real environment variables take precedence over the shared .env.
      env: {
        API_RELOAD: "false",
        API_PORT: String(API_PORT),
        API_CORS_ORIGINS: WEB_URL,
        API_ALLOWED_HOSTS: "127.0.0.1,localhost",
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm build && pnpm start --port ${WEB_PORT}`,
      url: WEB_URL,
      env: { NEXT_PUBLIC_API_URL: API_URL, NEXT_DIST_DIR: ".next-e2e" },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
