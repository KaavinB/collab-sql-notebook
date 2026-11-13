/**
 * One browser's WebSocket in one room.
 *
 * A connection is "pending" from the upgrade until its room has loaded and
 * its membership has been checked. Messages that arrive meanwhile are queued
 * in order and handled once it opens, so nothing a client sends right after
 * connecting (its sync step 1, its presence, early edits) is lost or
 * reordered.
 */
import type { WebSocket } from "ws";

import { colorFor, type AwarenessUser } from "./awareness.ts";
import { log } from "./log.ts";
import { CloseCode } from "./protocol.ts";
import type { Ticket } from "./ticket.ts";

/**
 * A socket whose unsent data passes this is closed (the client reconnects and
 * resyncs) instead of the server buffering for it forever. It has to be
 * bigger than the largest legitimate burst, which is a whole document sent
 * to a client as it joins, so it's well above the message size limit.
 */
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
/** Messages queued while a connection is pending; a client sends a handful. */
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

export type ConnectionState = "pending" | "open" | "closed";

export class Connection {
  state: ConnectionState = "pending";
  readonly user: AwarenessUser;
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  /** Set by the room when the connection opens. */
  onMessage: ((data: Uint8Array) => void) | null = null;

  readonly ws: WebSocket;
  readonly ticket: Ticket;

  constructor(ws: WebSocket, ticket: Ticket) {
    this.ws = ws;
    this.ticket = ticket;
    this.user = { id: ticket.userId, name: ticket.name, color: colorFor(ticket.userId) };
  }

  /** Viewers may read everything and send presence, but never change the document. */
  get canWrite(): boolean {
    return this.ticket.role !== "viewer";
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  get notebookId(): string {
    return this.ticket.notebookId;
  }

  receive(data: Uint8Array): void {
    if (this.state === "closed") return;
    if (this.state === "open" && this.onMessage) {
      this.onMessage(data);
      return;
    }
    this.queuedBytes += data.byteLength;
    if (this.queuedBytes > MAX_QUEUED_BYTES) {
      this.close(CloseCode.tryAgainLater, "too many messages before the document loaded");
      return;
    }
    this.queue.push(data);
  }

  /** Opens the connection and hands it every message queued so far, in order. */
  open(onMessage: (data: Uint8Array) => void): void {
    if (this.state !== "pending") return;
    this.state = "open";
    this.onMessage = onMessage;
    const queued = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    for (const data of queued) {
      if (this.state !== "open") break;
      onMessage(data);
    }
  }

  send(data: Uint8Array): void {
    if (this.state === "closed" || this.ws.readyState !== this.ws.OPEN) return;
    // Checked before sending: a single large message (a whole document) is
    // fine; data piling up because the client stopped reading is not.
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      log.warn("conn.slow", { notebook: this.notebookId, user: this.ticket.userId });
      this.close(CloseCode.tryAgainLater, "client is not keeping up");
      return;
    }
    this.ws.send(data);
  }

  close(code: number, reason = ""): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.queue = [];
    this.onMessage = null;
    this.ws.close(code, reason);
  }

  /** Marks it closed after the socket closed on its own (client left, network). */
  closed(): void {
    this.state = "closed";
    this.queue = [];
    this.onMessage = null;
  }
}
