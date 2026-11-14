import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests against the real stack: Postgres (`docker compose up -d`),
 * the taxi DuckDB file (`pnpm ingest`), the API, the sync server and a
 * production build of the web app. `pnpm check` needs Postgres for API integration tests, but does
 * not need the taxi dataset or browser binaries. Run these with `pnpm e2e`.
 *
 * The tests start their own API and web servers on their own ports, from the
 * current code, and never reuse a running server: a dev server on :3000 or an
 * old build would otherwise be tested by mistake. The web app is a production
 * build (not `next dev`, which compiles routes on first visit and made timing
 * flaky) in its own build directory.
 */
const WEB_PORT = 3100;
const API_PORT = 8100;
const SYNC_PORT = 8120;
const WEB_URL = `http://localhost:${WEB_PORT}`;
// localhost, like the web app: the session cookie is SameSite=Lax, and
// 127.0.0.1 would be a different site from localhost.
const API_URL = `http://localhost:${API_PORT}`;

// Read by the specs (Playwright workers inherit this process's environment).
const SYNC_URL = `ws://localhost:${SYNC_PORT}`;
// Fixed throwaway secrets: they only sign cookies and tickets for these
// local test servers.
const AUTH_SECRET = "e2e-only-secret-not-used-anywhere-else-0123456789";
const SYNC_TICKET_SECRET = "e2e-only-sync-secret-not-used-anywhere-else-0123456789";

process.env.E2E_API_URL = API_URL;
process.env.E2E_WEB_URL = WEB_URL;

export default defineConfig({
  testDir: "e2e",
  // A stray test.only must fail CI rather than silently skip every other test.
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: WEB_URL, trace: "retain-on-failure" },
  webServer: [
    {
      command: "pnpm --dir ../.. dev:api",
      url: `http://127.0.0.1:${API_PORT}/health`,
      // Real environment variables take precedence over the shared .env.
      env: {
        API_RELOAD: "false",
        API_PORT: String(API_PORT),
        API_CORS_ORIGINS: WEB_URL,
        API_ALLOWED_HOSTS: "127.0.0.1,localhost",
        WEB_URL,
        API_PUBLIC_URL: API_URL,
        // Tests sign in by name.
        AUTH_SECRET,
        SYNC_TICKET_SECRET,
        SYNC_PUBLIC_URL: SYNC_URL,
        // The AI assistant answers from a deterministic fake: e2e runs need no
        // key and can never spend money. The real key from .env is blanked.
        AI_FAKE_MODEL: "true",
        ANTHROPIC_API_KEY: "",
        AUTH_DEV_LOGIN: "true",
        AUTH_COOKIE_SECURE: "false",
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "pnpm --dir ../.. dev:sync",
      url: `http://127.0.0.1:${SYNC_PORT}/health`,
      env: {
        SYNC_PORT: String(SYNC_PORT),
        SYNC_ALLOWED_ORIGINS: WEB_URL,
        SYNC_TICKET_SECRET,
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
