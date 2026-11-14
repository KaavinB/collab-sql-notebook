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
 * Unsynced edits: the server confirms what it received (see
 * confirmations.ts), so this tab knows which of its edits the server has.
 * Edits are "unsynced" while they wait for a connection (offline), or when
 * they were sent but not confirmed in time (a connection that died without
 * either side noticing yet). The page shows that, and warns before the tab
 * closes.
 *
 * The browser's offline and online events are used as hints: going offline
 * drops the socket at once (the page says "Offline" instead of looking live
 * on a dead connection), and coming back online reconnects at once instead
 * of waiting out the provider's backoff or its 30 s watchdog.
 *
 * Losing edit rights with unconfirmed edits (an owner made you a viewer
 * while you were offline): the server will never take those edits, so the
 * connection stops with reason "demoted" and the page loads the notebook
 * again from the server, saying the edits weren't saved. Otherwise the tab
 * would keep showing text that exists only in it.
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
import {
  EditConfirmations,
  trackingWebSocket,
  type ConfirmationTimings,
  type WireTap,
} from "@/lib/notebook/confirmations";

export type SyncState =
  /** Opening the first connection. The document isn't loaded yet. */
  | { status: "connecting"; role: Role | null }
  /** Connected, and the document is up to date with the server. */
  | { status: "live"; role: Role }
  /** The connection dropped after loading. Edits are kept and merge on reconnect. */
  | { status: "offline"; role: Role }
  /** Stopped for good; `message` says why. */
  | { status: "stopped"; role: Role | null; reason: StopReason; message: string };

export type StopReason =
  | "deleted"
  | "no-access"
  | "signed-out"
  | "unavailable"
  | "rejected"
  /** Now a viewer, with edits the server never got: the page loads the document again. */
  | "demoted";

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

/**
 * Makes the provider. `tap` must see every frame its sockets send and
 * receive (the real factory wraps the WebSocket class), so the server's
 * confirmations can be tracked.
 */
export type ProviderFactory = (
  serverUrl: string,
  room: string,
  doc: Y.Doc,
  ticket: string,
  tap: WireTap,
) => Provider;

const defaultFactory: ProviderFactory = (serverUrl, room, doc, ticket, tap) =>
  new WebsocketProvider(serverUrl, room, doc, {
    params: { ticket },
    disableBc: true,
    WebSocketPolyfill: trackingWebSocket(tap),
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
  /** Called when the state changes, and when either of the edit checks below changes. */
  subscribe(listener: () => void): () => void;
  /**
   * Edits at risk: waiting for a connection, or sent but unconfirmed for too
   * long (the connection is probably dead). The page shows these as
   * "Unsynced", and the close-tab guard checks them.
   */
  hasUnsyncedEdits(): boolean;
  /** Any local edit the server hasn't confirmed yet, including one sent a moment ago. */
  hasUnconfirmedEdits(): boolean;
  destroy(): void;
}

export function connectNotebook(
  api: ApiClient,
  notebookId: string,
  createProvider: ProviderFactory = defaultFactory,
  confirmationTimings: Partial<ConfirmationTimings> = {},
): NotebookSync {
  const doc = new Y.Doc();
  const listeners = new Set<() => void>();
  let state: SyncState = { status: "connecting", role: null };
  let provider: Provider | null = null;
  let destroyed = false;
  let loaded = false;
  // A ticket refresh is under way: it reconnects by itself, with the new ticket.
  let awaitingTicket = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let ticketDelay = TICKET_RETRY_INITIAL_MS;
  // Ticket refusals (4401/4403) in a row without reaching sync. If the API
  // and the sync server disagree (different secrets, clocks more than a
  // ticket's lifetime apart), every new ticket is refused too; backing off
  // keeps each open tab from hammering both servers.
  let refusals = 0;

  const notify = () => {
    if (!destroyed) listeners.forEach((listener) => listener());
  };
  const set = (next: SyncState) => {
    if (destroyed) return;
    state = next;
    notify();
  };
  const role = () => state.role;

  const stop = (reason: StopReason, message: string) => {
    provider?.disconnect();
    set({ status: "stopped", role: role(), reason, message });
  };

  // Created before the provider, so it counts each local edit before the
  // provider sends it. Changes the provider applies came from the server.
  const confirmations = new EditConfirmations(
    doc,
    (origin) => provider !== null && origin === provider,
    notify,
    confirmationTimings,
  );
  const hasUnsyncedEdits = () =>
    confirmations.unconfirmed() && (state.status !== "live" || confirmations.overdue());

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

  // The user this connection belongs to, from its first ticket. Tickets are
  // fetched with whatever session cookie the browser holds now: if someone
  // else signed in in another tab, a later ticket names them, and this tab's
  // edits must not reach the server as theirs.
  // Fails closed: if the first ticket can't be read, no later ticket can be
  // shown to be ours, so a reconnect stops instead. (The API's tickets are
  // always readable; this only guards against something unexpected.)
  let owner: string | null | undefined; // undefined until the first ticket
  const sameOwner = (token: string): boolean => {
    const user = ticketUser(token);
    if (owner === undefined) owner = user;
    return user !== null && user === owner;
  };

  const refreshTicketAndReconnect = async () => {
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
    if (!sameOwner(ticket.ticket)) {
      stop("signed-out", "You're signed in as someone else now. Reload the page to continue.");
      return;
    }
    if (ticket.role === "viewer" && role() !== "viewer" && confirmations.unconfirmed()) {
      // The server drops a viewer's edits, so these can never be saved.
      // Stopping lets the page start over from the server's copy.
      stop(
        "demoted",
        "You can only view this notebook now, so your edits that hadn't reached the server " +
          "weren't saved. The notebook was reloaded from the server.",
      );
      return;
    }
    provider.params = { ticket: ticket.ticket };
    set(
      loaded
        ? { status: "offline", role: ticket.role }
        : { status: "connecting", role: ticket.role },
    );
    provider.connect();
  };

  const reconnectWithNewTicket = async () => {
    awaitingTicket = true;
    try {
      await refreshTicketAndReconnect();
    } finally {
      awaitingTicket = false;
    }
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
    sameOwner(ticket.ticket);
    set({ status: "connecting", role: ticket.role });
    const created = createProvider(
      `${ticket.url}/notebooks`,
      notebookId,
      doc,
      ticket.ticket,
      confirmations,
    );
    provider = created;
    created.on("status", ({ status }) => {
      if (status !== "connected" && loaded && state.status === "live") {
        set({ status: "offline", role: state.role });
      }
    });
    created.on("sync", (synced) => {
      if (!synced || state.status === "stopped") return;
      loaded = true;
      refusals = 0;
      set({ status: "live", role: role() ?? ticket.role });
    });
    created.on("closed", onClosed);
  })();

  // Opens a fresh socket now. Skipped before the first sync (the provider
  // is already trying), after stopping, and while a ticket is being
  // refreshed (that reconnects by itself, with the new ticket).
  const reconnectNow = () => {
    if (!provider || awaitingTicket || !loaded || state.status === "stopped") return;
    provider.disconnect();
    provider.connect();
  };
  const onOffline = () => {
    if (state.status === "live") reconnectNow();
  };
  const hasWindow = typeof window !== "undefined";
  if (hasWindow) {
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", reconnectNow);
  }

  return {
    doc,
    awareness: () => provider?.awareness ?? null,
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hasUnsyncedEdits,
    hasUnconfirmedEdits: () => confirmations.unconfirmed(),
    destroy() {
      destroyed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (hasWindow) {
        window.removeEventListener("offline", onOffline);
        window.removeEventListener("online", reconnectNow);
      }
      listeners.clear();
      confirmations.destroy();
      provider?.destroy();
      doc.destroy();
    },
  };
}

/**
 * The user ID a ticket names (its `u` claim), or null if it can't be read.
 * Only read, never trusted: the sync server verifies the signature. This
 * just notices a ticket issued to someone else.
 */
export function ticketUser(ticket: string): string | null {
  try {
    const encoded = ticket.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const payload: unknown = JSON.parse(atob(encoded));
    const user = (payload as { u?: unknown } | null)?.u;
    return typeof user === "string" ? user : null;
  } catch {
    return null;
  }
}
