/**
 * Prepares the Postgres database the integration tests use: creates it if
 * missing and migrates it with the API's Alembic migrations (Alembic owns
 * the schema; this server never creates tables itself).
 *
 * Database: SYNC_TEST_DATABASE_URL if set, otherwise DATABASE_URL's database
 * with "_sync_test" appended (notebook -> notebook_sync_test), so these tests
 * never share a database with the API's pytest suite (<db>_test) or touch
 * dev data. Either way the name must end in "_test", because tests truncate
 * every table.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import pg from "pg";
import type { TestProject } from "vitest/node";

import { toPgUrl } from "../src/config.ts";

declare module "vitest" {
  export interface ProvidedContext {
    /** pg-style URL of the migrated test database. */
    databaseUrl: string;
  }
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const API_DIR = path.join(REPO_ROOT, "services/api");

function testDatabaseUrl(): string {
  const envFile = path.join(REPO_ROOT, ".env");
  // Doesn't override variables already set in the environment.
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const explicit = process.env.SYNC_TEST_DATABASE_URL;
  let url: URL;
  if (explicit) {
    url = new URL(toPgUrl(explicit));
  } else {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error(
        "Sync tests need DATABASE_URL or SYNC_TEST_DATABASE_URL (see .env.example) and " +
          "Postgres running (docker compose up -d).",
      );
    }
    url = new URL(toPgUrl(base));
    url.pathname = `/${url.pathname.slice(1)}_sync_test`;
  }
  if (!url.pathname.endsWith("_test")) {
    throw new Error(
      `Refusing to run sync tests against ${url.pathname.slice(1)}: the name must end in ` +
        "'_test', because the tests truncate every table.",
    );
  }
  return url.toString();
}

export default async function setup(project: TestProject): Promise<void> {
  const databaseUrl = testDatabaseUrl();
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));

  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }

  // Alembic wants the SQLAlchemy form of the URL. No --env-file: the URL is
  // passed explicitly, and a checkout without .env (CI) must work too.
  const alembicUrl = databaseUrl.replace(/^postgresql:/, "postgresql+psycopg:");
  const result = spawnSync("uv", ["run", "--directory", API_DIR, "alembic", "upgrade", "head"], {
    env: { ...process.env, DATABASE_URL: alembicUrl },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`alembic upgrade failed:\n${result.stderr || result.error?.message}`);
  }
  project.provide("databaseUrl", databaseUrl);
}
