/**
 * Live collaboration: keeps this tab's copy of a notebook's Yjs document in
 * sync with everyone else's through the sync server.
 *
 * How a connection is made:
 * 1. Ask the API for a ticket (POST /notebooks/{id}/sync-ticket). It's
 *    signed, lives 60 seconds, and says who we are and our role.
 * 2. Open a WebSocket to the sync server with it. y-websocket's provider
 *    speaks the sync protocol: it exchanges what each side is missing, then
 *    streams every edit both ways. It also carries "awareness": each
 *    person's cursor and name, which is how collaborators' cursors appear.
 * 3. If the connection drops, the provider reconnects by itself, with
 *    backoff. Edits made meanwhile stay in this tab's document and merge
 *    when it's back (that's what a CRDT is for).
 *
 * The sync server closes connections with its own codes:
 * - 4401: the ticket is invalid or expired (e.g. reconnecting long after
 *   it was issued). Get a new ticket and reconnect.
 * - 4403: our access changed. Get a new ticket: if the API still lets us
 *   in, we reconnect with the new role; if not, stop.
 * - 4404: the notebook was deleted. Stop.
 * - 4400 / 4413: the server rejected something this tab sent. Stop;
 *   reconnecting would send it again.
 *
 * Repeated ticket refusals back off (1 s doubling to 15 s), so a server
 * misconfiguration can't turn every open tab into a reconnect loop.
 *
 * BroadcastChannel is off: by default y-websocket also syncs tabs of the
 * same browser directly, bypassing the server. A view-only tab and an
 * editing tab of the same browser would then share edits, and the
 * viewer's would reach the server as the editor's.
 */
import { WebsocketProvider } from "y-websocket";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { ApiError, type ApiClient, type Role } from "@/lib/api";

export type SyncState =
  /** Opening the first connection. The document isn't loaded yet. */
  | { status: "connecting"; role: Role | null }
  /** Connected, and the document is up to date with the server. */
  | { status: "live"; role: Role }
  /** The connection dropped after loading. Edits are kept and merge on reconnect. */
  | { status: "offline"; role: Role }
  /** Stopped for good; `message` says why. */
  | { status: "stopped"; role: Role | null; reason: StopReason; message: string };

export type StopReason = "deleted" | "no-access" | "signed-out" | "unavailable" | "rejected";

/** The parts of y-websocket's provider this module uses (so tests can fake it). */
export interface Provider {
  awareness: Awareness;
  params: Record<string, string>;
  connect(): void;
  disconnect(): void;
  destroy(): void;
  on(event: "status", handler: (event: { status: string }) => void): void;
  on(event: "sync", handler: (synced: boolean) => void): void;
  on(event: "closed", handler: (event: { code: number; reason: string }) => void): void;
}

export type ProviderFactory = (
  serverUrl: string,
  room: string,
  doc: Y.Doc,
  ticket: string,
) => Provider;

const defaultFactory: ProviderFactory = (serverUrl, room, doc, ticket) =>
  new WebsocketProvider(serverUrl, room, doc, {
    params: { ticket },
    disableBc: true,
    // Close codes 4400-4499 stop the provider (its default). This module
    // handles them: refresh the ticket, or stop and say why.
  }) as unknown as Provider;

const TICKET_RETRY_INITIAL_MS = 1_000;
const TICKET_RETRY_MAX_MS = 15_000;

export interface NotebookSync {
  readonly doc: Y.Doc;
  /** The provider's awareness, once connected; null before the first ticket. */
  awareness(): Awareness | null;
  get(): SyncState;
  subscribe(listener: () => void): () => void;
  /** True while there are local edits the server hasn't confirmed (offline edits). */
  hasUnsyncedEdits(): boolean;
  destroy(): void;
}

export function connectNotebook(
  api: ApiClient,
  notebookId: string,
  createProvider: ProviderFactory = defaultFactory,
): NotebookSync {
  const doc = new Y.Doc();
  const listeners = new Set<() => void>();
  let state: SyncState = { status: "connecting", role: null };
  let provider: Provider | null = null;
  let destroyed = false;
  let loaded = false;
  let connected = false;
  let editedWhileOffline = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let ticketDelay = TICKET_RETRY_INITIAL_MS;
  // Ticket refusals (4401/4403) in a row without reaching sync. If the API
  // and the sync server disagree (different secrets, clocks more than a
  // ticket's lifetime apart), every new ticket is refused too; backing off
  // keeps each open tab from hammering both servers.
  let refusals = 0;

  const set = (next: SyncState) => {
    if (destroyed) return;
    state = next;
    listeners.forEach((listener) => listener());
  };
  const role = () => state.role;

  const stop = (reason: StopReason, message: string) => {
    provider?.disconnect();
    set({ status: "stopped", role: role(), reason, message });
  };

  // Edits made while disconnected are only in this tab until it reconnects.
  doc.on("update", (_update: Uint8Array, origin: unknown) => {
    if (origin !== provider && !connected) editedWhileOffline = true;
  });

  /** Gets a ticket; on a definitive refusal, stops and returns null. Retries transient failures. */
  const fetchTicket = async (): Promise<{ ticket: string; url: string; role: Role } | null> => {
    while (!destroyed) {
      try {
        const ticket = await api.syncTicket(notebookId);
        ticketDelay = TICKET_RETRY_INITIAL_MS;
        return ticket;
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.status === 401) {
            stop("signed-out", "Your session ended. Sign in again to keep editing.");
            return null;
          }
          if (error.status === 403 || error.status === 404) {
            stop("no-access", "You no longer have access to this notebook.");
            return null;
          }
          if (error.status === 503 && error.kind === "unavailable") {
            stop("unavailable", error.message);
            return null;
          }
        }
        // Network trouble or a busy server: try again shortly.
        await new Promise<void>((resolve) => {
          retryTimer = setTimeout(resolve, ticketDelay);
        });
        ticketDelay = Math.min(ticketDelay * 2, TICKET_RETRY_MAX_MS);
      }
    }
    return null;
  };

  const reconnectWithNewTicket = async () => {
    refusals++;
    if (refusals > 1) {
      const delay = Math.min(TICKET_RETRY_INITIAL_MS * 2 ** (refusals - 2), TICKET_RETRY_MAX_MS);
      await new Promise<void>((resolve) => {
        retryTimer = setTimeout(resolve, delay);
      });
      if (destroyed) return;
    }
    const ticket = await fetchTicket();
    if (!ticket || destroyed || !provider) return;
    provider.params = { ticket: ticket.ticket };
    set(
      loaded
        ? { status: "offline", role: ticket.role }
        : { status: "connecting", role: ticket.role },
    );
    provider.connect();
  };

  const onClosed = ({ code }: { code: number }) => {
    if (code === 4401 || code === 4403) void reconnectWithNewTicket();
    else if (code === 4404) stop("deleted", "This notebook was deleted.");
    else
      stop("rejected", "The server refused a change from this tab. Reload the page to continue.");
  };

  (async () => {
    const ticket = await fetchTicket();
    if (!ticket || destroyed) return;
    set({ status: "connecting", role: ticket.role });
    const created = createProvider(`${ticket.url}/notebooks`, notebookId, doc, ticket.ticket);
    provider = created;
    created.on("status", ({ status }) => {
      connected = status === "connected";
      if (!connected && loaded && state.status === "live") {
        set({ status: "offline", role: state.role });
      }
    });
    created.on("sync", (synced) => {
      if (!synced || state.status === "stopped") return;
      loaded = true;
      editedWhileOffline = false;
      refusals = 0;
      set({ status: "live", role: role() ?? ticket.role });
    });
    created.on("closed", onClosed);
  })();

  return {
    doc,
    awareness: () => provider?.awareness ?? null,
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hasUnsyncedEdits: () => editedWhileOffline,
    destroy() {
      destroyed = true;
      if (retryTimer) clearTimeout(retryTimer);
      listeners.clear();
      provider?.destroy();
      doc.destroy();
    },
  };
}
