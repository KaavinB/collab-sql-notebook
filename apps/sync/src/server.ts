/**
 * The HTTP and WebSocket front door.
 *
 *   GET /health                         200, for load balancers and scripts
 *   upgrade /notebooks/<uuid>?ticket=…  the sync socket for one notebook
 *   anything else                       404
 *
 * Checks before a socket is accepted, in order:
 *   1. path: must be /notebooks/<uuid>, else HTTP 404;
 *   2. Origin: must be one of SYNC_ALLOWED_ORIGINS, else HTTP 403. Browsers
 *      always send Origin on WebSocket upgrades, and a page on another site
 *      can open a socket to any host, so this is what stops a foreign page
 *      using a ticket it got hold of;
 *   3. ticket: genuine, unexpired and for this notebook. A bad ticket is
 *      accepted and then closed with 4401, because browsers hide the status
 *      of a refused upgrade from scripts, while a close code is visible: the
 *      client needs to know to fetch a new ticket.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import pg from "pg";
import { WebSocketServer, type WebSocket } from "ws";

import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { NotifyListener, type ListenerTimings } from "./notify.ts";
import { CloseCode } from "./protocol.ts";
import { DEFAULT_MANAGER_TIMINGS, RoomManager, type ManagerTimings } from "./rooms.ts";
import { Store } from "./store.ts";
import { UUID_PATTERN, verifyTicket, type Ticket } from "./ticket.ts";

/**
 * Largest WebSocket message accepted. Normal traffic is tiny (a keystroke is
 * tens of bytes), but the first sync from a client that edited offline
 * carries everything it changed, and pasting a large block of SQL or
 * markdown is one update. 2 MB leaves room for that while capping what one
 * message can make the server buffer and parse.
 */
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
/** Dead TCP connections (laptop lid closed) are found by ping/pong at this interval. */
const PING_INTERVAL_MS = 30_000;
const NOTEBOOK_PATH = /^\/notebooks\/([0-9A-Fa-f-]{36})$/;
// WebSocket close code ws uses when a message exceeds maxPayload.
const WS_MESSAGE_TOO_BIG = 1009;

export interface SyncServerOptions {
  config: Config;
  /** Defaults to a pool on config.databaseUrl, closed on stop. */
  pool?: pg.Pool;
  /** Defaults to a Store on the pool. Tests pass one that can be slowed down. */
  store?: Store;
  timings?: Partial<ManagerTimings>;
  listenerTimings?: ListenerTimings;
  /** Off in tests that drive events directly. */
  listen?: boolean;
}

export interface SyncServer {
  readonly server: Server;
  readonly manager: RoomManager;
  readonly listener: NotifyListener | null;
  readonly store: Store;
  start(): Promise<AddressInfo>;
  /** Stops accepting, saves every room, closes the pool. */
  stop(): Promise<void>;
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * ws closes with 1009 when a message is over maxPayload, and has no option
 * to choose the code. The client needs 4413 to tell "too large" apart from
 * other failures, so this socket's close() translates it.
 */
function translateTooBig(ws: WebSocket): void {
  const close = ws.close.bind(ws);
  ws.close = (code?: number, reason?: string | Buffer) =>
    code === WS_MESSAGE_TOO_BIG
      ? close(CloseCode.messageTooLarge, "message too large")
      : close(code, reason);
}

export function createSyncServer(options: SyncServerOptions): SyncServer {
  const { config } = options;
  const ownsPool = options.pool === undefined;
  const pool = options.pool ?? new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  pool.on("error", (error) => log.warn("pg.idle_client_error", { error: error.message }));
  const store = options.store ?? new Store(pool);
  const manager = new RoomManager(store, { ...DEFAULT_MANAGER_TIMINGS, ...options.timings });
  const listener =
    options.listen === false
      ? null
      : new NotifyListener(
          config.databaseUrl,
          (event) => manager.handleEvent(event),
          options.listenerTimings,
          // Access changes and deletions sent while it was down are lost.
          () => void manager.recheckAccess(),
        );

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    // Compression stays off: inflating attacker-chosen data costs memory and
    // CPU before maxPayload applies to the result, and Yjs updates are
    // already compact.
    perMessageDeflate: false,
  });
  const alive = new WeakMap<WebSocket, boolean>();
  let stopping = false;

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    }
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const url = new URL(req.url ?? "/", "http://sync.invalid");
    const match = NOTEBOOK_PATH.exec(url.pathname);
    const notebookId = match?.[1]?.toLowerCase();
    if (!notebookId || !UUID_PATTERN.test(notebookId)) return reject(socket, 404, "Not Found");
    const origin = req.headers.origin;
    if (origin === undefined || !config.allowedOrigins.has(origin)) {
      log.warn("upgrade.bad_origin", { notebook: notebookId });
      return reject(socket, 403, "Forbidden");
    }
    if (stopping) return reject(socket, 503, "Service Unavailable");
    const tickets = url.searchParams.getAll("ticket");
    const ticket =
      tickets.length === 1
        ? verifyTicket(tickets[0]!, config.ticketSecret)
        : (null as Ticket | null);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", (error) =>
        log.warn("conn.error", { notebook: notebookId, error: error.message }),
      );
      translateTooBig(ws);
      if (ticket === null || ticket.notebookId !== notebookId) {
        log.info("conn.bad_ticket", { notebook: notebookId });
        ws.close(CloseCode.badTicket, "invalid or expired ticket");
        return;
      }
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      manager.connect(ws, ticket);
    });
  });

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  pinger.unref();

  return {
    server,
    manager,
    listener,
    store,
    start() {
      listener?.start();
      return new Promise((resolve, rejectStart) => {
        server.once("error", rejectStart);
        server.listen(config.port, config.host, () => {
          server.off("error", rejectStart);
          const address = server.address() as AddressInfo;
          log.info("server.listening", { host: address.address, port: address.port });
          resolve(address);
        });
      });
    },
    async stop() {
      stopping = true;
      clearInterval(pinger);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      await listener?.stop();
      await manager.shutdown();
      // Give close handshakes a moment to finish, then cut whatever is left
      // (a client that never answers the close frame).
      const deadline = Date.now() + 1000;
      while (wss.clients.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      for (const ws of wss.clients) ws.terminate();
      server.closeAllConnections();
      await closed;
      if (ownsPool) await pool.end();
    },
  };
}
