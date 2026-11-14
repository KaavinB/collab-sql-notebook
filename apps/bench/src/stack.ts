/**
 * Starts the stack the benchmarks measure, on ports of their own, or
 * attaches to one already running there.
 *
 *   API   http://localhost:8200   (uv run notebook-api)
 *   sync  ws://localhost:8220     (node apps/sync/src/main.ts, with sync-probe.ts)
 *   web   http://localhost:3200   (production build in apps/web/.next-bench; latency only)
 *   DB    notebook_bench_test     (created and migrated here; never the dev database)
 *
 * Like the e2e tests, the started servers get fixed throwaway secrets, the
 * dev sign-in, and the AI's fake model with the real API key blanked, so a
 * benchmark can never spend money. Their output goes to log files in the
 * run's results directory, not the terminal.
 *
 * Attaching: if every service a benchmark needs already answers on these
 * ports, it is used as is (and the sync server's CPU and memory aren't
 * measured, since this process didn't start it). If only some answer, the
 * benchmark stops rather than mix a running server with a new one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, readFileSync, writeFileSync, type WriteStream } from "node:fs";
import path from "node:path";

import pg from "pg";

import type { ProbeReading } from "./sync-probe.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const API_DIR = path.join(REPO_ROOT, "services/api");

export const WEB_PORT = 3200;
export const API_PORT = 8200;
export const SYNC_PORT = 8220;
// localhost, like the e2e tests: the session cookie is SameSite=Lax, and
// 127.0.0.1 would be a different site from localhost.
export const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
export const API_URL = `http://localhost:${API_PORT}`;
export const SYNC_URL = `ws://localhost:${SYNC_PORT}`;
// Throwaway values: they only sign cookies and tickets for these local servers.
const AUTH_SECRET = "bench-only-secret-not-used-anywhere-else-0123456789";
const SYNC_TICKET_SECRET = "bench-only-sync-secret-not-used-anywhere-else-0123456789";
const DEFAULT_DATABASE = "notebook_bench_test";
const NEXT_DIST_DIR = ".next-bench";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The benchmark database, in the SQLAlchemy form the API uses:
 * BENCH_DATABASE_URL if set, else DATABASE_URL with its database renamed to
 * notebook_bench_test. The name must end in _test, so a typo can never point
 * a benchmark at the dev database. The derived URL must also be on this
 * machine: DATABASE_URL might name a shared or remote server, and a benchmark
 * creates a database and hammers it, which should only happen there when
 * someone asks for it by setting BENCH_DATABASE_URL.
 */
export function benchDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.BENCH_DATABASE_URL;
  let url: URL;
  if (explicit) {
    url = new URL(explicit);
  } else {
    if (!env.DATABASE_URL) {
      throw new Error("Set DATABASE_URL or BENCH_DATABASE_URL (see .env.example)");
    }
    url = new URL(env.DATABASE_URL);
    url.pathname = `/${DEFAULT_DATABASE}`;
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error(
        `DATABASE_URL's server (${url.hostname}) isn't on this machine; set BENCH_DATABASE_URL ` +
          "explicitly to benchmark against it",
      );
    }
  }
  if (!/^postgres(ql)?(\+[a-z0-9_]+)?:$/i.test(url.protocol)) {
    throw new Error("The benchmark database URL must be a postgresql:// URL");
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+_test$/.test(name)) {
    throw new Error(`Refusing benchmark database "${name}": its name must end in _test`);
  }
  return url.toString();
}

/** postgresql+psycopg://… -> postgresql://… for `pg`. */
function pgUrl(url: string): string {
  return url.replace(/^postgres(?:ql)?(?:\+[a-z0-9_]+)?:/i, "postgresql:");
}

async function ensureDatabase(url: string, log: WriteStream): Promise<void> {
  const target = new URL(pgUrl(url));
  const name = decodeURIComponent(target.pathname.slice(1));
  const admin = new URL(target);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (exists.rowCount === 0) {
      // The name was checked against [A-Za-z0-9_]+ above, so quoting is enough.
      await client.query(`CREATE DATABASE "${name}"`);
      log.write(`created database ${name}\n`);
    }
  } finally {
    await client.end();
  }
  const sqlalchemyUrl = pgUrl(url).replace(/^postgresql:/, "postgresql+psycopg:");
  await runToCompletion("uv", ["run", "--directory", API_DIR, "alembic", "upgrade", "head"], {
    env: { ...process.env, DATABASE_URL: sqlalchemyUrl },
    log,
    what: "database migration",
  });
}

function runToCompletion(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; log: WriteStream; what: string; cwd?: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(options.log, { end: false });
    child.stderr.pipe(options.log, { end: false });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${options.what} failed (exit ${code}); see ${options.log.path}`));
    });
  });
}

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function waitUntilAnswering(
  url: string,
  timeoutMs: number,
  what: string,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${what} exited (${child.exitCode}) on start`);
    if (await answers(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${what} didn't answer at ${url} within ${timeoutMs / 1000} s`);
}

/**
 * Every server this process has started and not yet stopped. Servers run in
 * their own process groups (so stopping one stops its children), which also
 * means a Ctrl-C in the terminal doesn't reach them: the signal handler stops
 * whatever is in here, including servers started before Stack.up returned.
 */
const running = new Set<Server>();

/** Stops every server this process started. Safe to call more than once. */
export async function stopAllServers(): Promise<void> {
  await Promise.all([...running].map((server) => server.stop()));
}

/** A long-running server in its own process group, so stopping it stops its children too. */
class Server {
  readonly child: ChildProcess;

  constructor(child: ChildProcess) {
    this.child = child;
    running.add(this);
    child.once("exit", () => running.delete(this));
  }

  static start(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    log: WriteStream,
    ipc = false,
  ): Server {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      detached: true,
      stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    return new Server(child);
  }

  async stop(): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined || this.child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig);
      } catch {
        // Already gone.
      }
    };
    signal("SIGTERM");
    const timer = setTimeout(() => signal("SIGKILL"), 25_000);
    await exited;
    clearTimeout(timer);
  }
}

export interface StackOptions {
  /** The web app too (the browser benchmark); the load test needs only API and sync. */
  web: boolean;
  /** Directory for the servers' log files. */
  logDir: string;
  /** Called with progress lines for the terminal. */
  say: (line: string) => void;
}

export interface SyncUsage {
  userUs: number;
  systemUs: number;
  rssBytes: number;
  atUs: number;
}

export class Stack {
  readonly attached: boolean;
  /** The database the started servers use; null when attached (unknown). */
  readonly databaseName: string | null;
  private readonly servers: Server[];
  private readonly syncServer: Server | null;
  private readonly logs: WriteStream[];

  private constructor(
    attached: boolean,
    servers: Server[],
    syncServer: Server | null,
    logs: WriteStream[],
    databaseName: string | null,
  ) {
    this.attached = attached;
    this.servers = servers;
    this.syncServer = syncServer;
    this.logs = logs;
    this.databaseName = databaseName;
  }

  static async up(options: StackOptions): Promise<Stack> {
    const checks = [
      { name: "API", url: `http://127.0.0.1:${API_PORT}/health` },
      { name: "sync server", url: `http://127.0.0.1:${SYNC_PORT}/health` },
      ...(options.web ? [{ name: "web app", url: WEB_ORIGIN }] : []),
    ];
    const up = await Promise.all(checks.map((check) => answers(check.url)));
    if (up.every(Boolean)) {
      options.say("Attaching to the stack already running on the bench ports.");
      return new Stack(true, [], null, [], null);
    }
    if (up.some(Boolean)) {
      const running = checks.filter((_, i) => up[i]).map((check) => check.name);
      throw new Error(
        `Only some services answer on the bench ports (${running.join(", ")}). ` +
          "Stop them, or start all of them, before running a benchmark.",
      );
    }

    const log = (name: string) => createWriteStream(path.join(options.logDir, `${name}.log`));
    const logs = { setup: log("setup"), api: log("api"), sync: log("sync"), web: log("web") };
    const databaseUrl = benchDatabaseUrl();
    const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    const servers: Server[] = [];
    const stack = (sync: Server | null) =>
      new Stack(false, servers, sync, Object.values(logs), databaseName);
    try {
      options.say(`Preparing database ${databaseName}…`);
      await ensureDatabase(databaseUrl, logs.setup);

      const sqlalchemyUrl = pgUrl(databaseUrl).replace(/^postgresql:/, "postgresql+psycopg:");
      const shared = { ...process.env, DATABASE_URL: sqlalchemyUrl, SYNC_TICKET_SECRET };
      options.say("Starting the API and the sync server…");
      const api = Server.start(
        "uv",
        ["run", "--directory", API_DIR, "notebook-api"],
        {
          ...shared,
          API_RELOAD: "false",
          API_HOST: "127.0.0.1",
          API_PORT: String(API_PORT),
          API_CORS_ORIGINS: WEB_ORIGIN,
          API_ALLOWED_HOSTS: "127.0.0.1,localhost",
          WEB_URL: WEB_ORIGIN,
          API_PUBLIC_URL: API_URL,
          AUTH_SECRET,
          AUTH_DEV_LOGIN: "true",
          AUTH_COOKIE_SECURE: "false",
          SYNC_PUBLIC_URL: SYNC_URL,
          // Never call Claude from a benchmark.
          AI_FAKE_MODEL: "true",
          ANTHROPIC_API_KEY: "",
        },
        logs.api,
      );
      servers.push(api);
      const sync = Server.start(
        process.execPath,
        ["--import", path.join(import.meta.dirname, "sync-probe.ts"), "apps/sync/src/main.ts"],
        {
          ...shared,
          SYNC_HOST: "127.0.0.1",
          SYNC_PORT: String(SYNC_PORT),
          SYNC_ALLOWED_ORIGINS: WEB_ORIGIN,
        },
        logs.sync,
        true,
      );
      servers.push(sync);
      await Promise.all([
        waitUntilAnswering(checks[0]!.url, 60_000, "API", api.child),
        waitUntilAnswering(checks[1]!.url, 30_000, "sync server", sync.child),
      ]);

      if (options.web) {
        const webEnv = {
          ...process.env,
          NEXT_DIST_DIR,
          NEXT_PUBLIC_API_URL: API_URL,
        };
        options.say(`Building the web app into apps/web/${NEXT_DIST_DIR} (takes a minute)…`);
        // `next build` adds its build directory's type folders to
        // tsconfig.json when they're missing (and reformats the file). They
        // are listed there already; if a future Next version rewrites the
        // file anyway, it's put back so a benchmark never leaves the
        // checkout modified (which the next run would record as dirty).
        const tsconfig = path.join(REPO_ROOT, "apps/web/tsconfig.json");
        const tsconfigBefore = readFileSync(tsconfig, "utf8");
        try {
          await runToCompletion("pnpm", ["--filter", "web", "build"], {
            env: webEnv,
            log: logs.web,
            what: "web build",
          });
        } finally {
          if (readFileSync(tsconfig, "utf8") !== tsconfigBefore) {
            writeFileSync(tsconfig, tsconfigBefore);
            logs.setup.write("restored apps/web/tsconfig.json after next build rewrote it\n");
          }
        }
        const web = Server.start(
          "pnpm",
          ["--filter", "web", "start", "--port", String(WEB_PORT), "--hostname", "127.0.0.1"],
          webEnv,
          logs.web,
        );
        servers.push(web);
        await waitUntilAnswering(WEB_ORIGIN, 60_000, "web app", web.child);
      }
      return stack(sync);
    } catch (error) {
      await stack(null).down();
      throw error;
    }
  }

  /** The sync server's CPU time and memory now, or null if this process didn't start it. */
  syncUsage(timeoutMs = 2000): Promise<SyncUsage | null> {
    const child = this.syncServer?.child;
    if (!child?.connected) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.off("message", onMessage);
        resolve(null);
      }, timeoutMs);
      const onMessage = (message: ProbeReading) => {
        if (message?.type !== "bench-probe") return;
        clearTimeout(timer);
        child.off("message", onMessage);
        resolve({
          userUs: message.userUs,
          systemUs: message.systemUs,
          rssBytes: message.rssBytes,
          atUs: message.atUs,
        });
      };
      child.on("message", onMessage);
      child.send({ type: "bench-probe" });
    });
  }

  async down(): Promise<void> {
    // Reverse order: the web app and sync server before the API.
    for (const server of [...this.servers].reverse()) await server.stop();
    for (const log of this.logs) log.end();
  }
}
