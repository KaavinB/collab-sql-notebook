/**
 * The sync server: every browser editing a notebook keeps a WebSocket open
 * to it. It relays Yjs document updates and presence between them, decides
 * who may connect and who may write, and is the only writer of notebook
 * documents to Postgres.
 *
 * Map of the code:
 *   server.ts     HTTP + WebSocket front door: path, Origin and ticket checks
 *   ticket.ts     verifies the signed, 60-second tickets the API issues
 *   rooms.ts      creates, shares and unloads rooms; applies API events
 *   room.ts       one notebook: its Y.Doc, connections, batching to Postgres
 *   connection.ts one socket: queueing before the room loads, backpressure
 *   protocol.ts   the y-websocket wire format and close codes
 *   awareness.ts  presence, with identities taken from tickets
 *   store.ts      Postgres: load, append to the update log, compact
 *   notify.ts     LISTEN for run/access/deletion events from the API
 *
 * Entry point: `node src/main.ts` (Node runs the TypeScript directly by
 * stripping types; there is no build step). `pnpm dev:sync` at the repo root
 * runs it with the root .env loaded.
 *
 * On SIGINT/SIGTERM it stops accepting connections, closes sockets with 1012
 * (clients reconnect to the next instance), writes and compacts every open
 * room, closes the database pool and exits. A second signal, or the
 * shutdown taking longer than SHUTDOWN_TIMEOUT_MS, exits at once.
 */
import { ConfigError, loadConfig } from "./config.ts";
import { errorMessage, log } from "./log.ts";
import { createSyncServer } from "./server.ts";

// Long enough for a few rounds of database retries; short enough that an
// orchestrator's own kill timeout (often 30 s) isn't what ends the process.
const SHUTDOWN_TIMEOUT_MS = 20_000;

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`[sync] config error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const sync = createSyncServer({ config });
await sync.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    log.warn("shutdown.forced", { signal });
    process.exit(1);
  }
  shuttingDown = true;
  log.info("shutdown.started", { signal });
  const timer = setTimeout(() => {
    log.error("shutdown.timeout", { ms: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  try {
    await sync.stop();
    log.info("shutdown.done");
    process.exit(0);
  } catch (error) {
    log.error("shutdown.failed", { error: errorMessage(error) });
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
