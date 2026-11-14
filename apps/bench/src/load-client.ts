/**
 * One headless editor: a real Yjs document synced through y-websocket's
 * WebsocketProvider (the browser's provider) over a `ws` socket, with a real
 * ticket from the API.
 *
 * What it does like a browser: the same sync and awareness protocol, the
 * Origin header the server checks, a sql cell shaped like the web app's, and
 * a cursor (awareness) update after every keystroke, as y-codemirror sends.
 * What it doesn't: no DOM, no CodeMirror, no React. It measures the time
 * from an edit being made to it being applied in another client's Y.Doc,
 * not to a screen.
 */
import { generateKeyBetween } from "fractional-indexing";
import WebSocket from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import { nowUs } from "./clock.ts";
import { encodeStamp, MAX_CLIENTS, MAX_SEQ, parseStamps, type ReceiptColumns } from "./samples.ts";

export interface ClientSpec {
  index: number;
  notebookId: string;
  /** The sync server's base URL from the ticket (ws://host:port). */
  syncUrl: string;
  ticket: string;
  /** The web app's origin, sent as the browser would. */
  origin: string;
  /** Whether this client records receipts (every client applies every update regardless). */
  observer: boolean;
  /** Send a cursor update after every keystroke, as an editor in a browser does. */
  awareness: boolean;
  /** The id of the cell it creates; `load-<index>` by default. */
  cellId?: string;
}

/** Socket traffic counted at the clients, i.e. what the sync server received and sent. */
export interface Traffic {
  sentMessages: number;
  sentBytes: number;
  receivedMessages: number;
  receivedBytes: number;
}

export function emptyTraffic(): Traffic {
  return { sentMessages: 0, sentBytes: 0, receivedMessages: 0, receivedBytes: 0 };
}

function byteLength(data: unknown): number {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((sum: number, part) => sum + byteLength(part), 0);
  if (typeof data === "string") return Buffer.byteLength(data);
  return 0;
}

/** A ws socket that sends the web app's Origin and counts traffic. */
function countingSocket(origin: string, traffic: Traffic): typeof globalThis.WebSocket {
  class CountingWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, { origin });
      this.on("message", (data) => {
        traffic.receivedMessages++;
        traffic.receivedBytes += byteLength(data);
      });
    }

    override send(data: unknown, ...rest: unknown[]): void {
      traffic.sentMessages++;
      traffic.sentBytes += byteLength(data);
      (super.send as (...args: unknown[]) => void)(data, ...rest);
    }
  }
  return CountingWebSocket as unknown as typeof globalThis.WebSocket;
}

export function cellIdFor(index: number): string {
  return `load-${index}`;
}

export class LoadClient {
  readonly doc = new Y.Doc();
  readonly provider: WebsocketProvider;
  /** Send times (µs) of this client's edits, indexed by seq. */
  readonly sends: number[] = [];
  /** Times the connection closed before stop() was called. */
  unexpectedCloses = 0;
  readonly spec: ClientSpec;
  private readonly receipts: ReceiptColumns;
  private text: Y.Text | null = null;
  private stopped = false;

  constructor(spec: ClientSpec, traffic: Traffic, receipts: ReceiptColumns) {
    this.spec = spec;
    this.receipts = receipts;
    if (!Number.isInteger(spec.index) || spec.index < 0 || spec.index >= MAX_CLIENTS) {
      throw new RangeError(`client index must be below ${MAX_CLIENTS}`);
    }
    this.provider = new WebsocketProvider(`${spec.syncUrl}/notebooks`, spec.notebookId, this.doc, {
      params: { ticket: spec.ticket },
      WebSocketPolyfill: countingSocket(spec.origin, traffic),
      // In one process, providers would otherwise also sync through a
      // BroadcastChannel and bypass the server.
      disableBc: true,
      // A reconnect would present the same ticket, which expires after 60 s.
      // A dropped connection is counted instead, not hidden by a retry.
      shouldReconnect: () => false,
      connect: false,
    });
    this.provider.on("connection-close", () => {
      if (!this.stopped) this.unexpectedCloses++;
    });
    if (spec.observer) this.observe();
  }

  /** Connects and resolves once the first sync with the server is done. */
  connect(timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`client ${this.spec.index}: no sync within ${timeoutMs} ms`));
      }, timeoutMs);
      const onSync = (synced: boolean) => {
        if (!synced) return;
        cleanup();
        resolve();
      };
      const onClose = (event: { code?: number } | null) => {
        cleanup();
        reject(new Error(`client ${this.spec.index}: closed before sync (${event?.code ?? "?"})`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.provider.off("sync", onSync);
        this.provider.off("connection-close", onClose);
      };
      this.provider.on("sync", onSync);
      this.provider.on("connection-close", onClose);
      this.provider.connect();
    });
  }

  /** Adds this client's own sql cell after the last existing one, as the web app shapes it. */
  createCell(): void {
    const cells = this.doc.getMap<Y.Map<unknown>>("cells");
    let last: string | null = null;
    for (const cell of cells.values()) {
      const order = cell instanceof Y.Map ? cell.get("order") : null;
      if (typeof order === "string" && (last === null || order > last)) last = order;
    }
    let order: string;
    try {
      order = generateKeyBetween(last, null);
    } catch {
      // Another editor wrote a key the library can't extend; start a fresh range.
      order = generateKeyBetween(null, null);
    }
    this.doc.transact(() => {
      const cell = new Y.Map<unknown>();
      cell.set("type", "sql");
      cell.set("order", order);
      const source = new Y.Text();
      cell.set("source", source);
      cell.set("lastRunId", null);
      cells.set(this.spec.cellId ?? cellIdFor(this.spec.index), cell);
      this.text = source;
    });
  }

  cellCount(): number {
    return this.doc.getMap("cells").size;
  }

  /** Types one keystroke: a stamp at the end of this client's cell, then the cursor after it. */
  sendEdit(): void {
    const text = this.text;
    if (!text) throw new Error("createCell() first");
    const seq = this.sends.length;
    if (seq >= MAX_SEQ) throw new RangeError(`client ${this.spec.index} sent ${MAX_SEQ} edits`);
    const sentAtUs = nowUs();
    this.sends.push(sentAtUs);
    text.insert(text.length, encodeStamp({ sender: this.spec.index, seq, sentAtUs }));
    if (this.spec.awareness) {
      // y-codemirror sends the selection as relative positions after each
      // change; the server checks this exact shape.
      const position = Y.createRelativePositionFromTypeIndex(text, text.length);
      this.provider.awareness.setLocalStateField("cursor", { anchor: position, head: position });
    }
  }

  private observe(): void {
    this.doc.getMap("cells").observeDeep((events, transaction) => {
      if (transaction.local) return;
      const receivedAtUs = nowUs();
      for (const event of events) {
        if (!(event instanceof Y.YTextEvent)) continue;
        for (const op of event.delta) {
          if (typeof op.insert !== "string") continue;
          for (const stamp of parseStamps(op.insert)) {
            this.receipts.push(
              stamp.sender,
              stamp.seq,
              this.spec.index,
              stamp.sentAtUs,
              receivedAtUs,
            );
          }
        }
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.provider.destroy();
    this.doc.destroy();
  }
}
