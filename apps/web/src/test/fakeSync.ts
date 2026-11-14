import * as encoding from "lib0/encoding";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { syncStep1Frame, type WireTap } from "@/lib/notebook/confirmations";
import type { Provider, ProviderFactory } from "@/lib/notebook/sync";

type Handlers = {
  status: ((event: { status: string }) => void)[];
  sync: ((synced: boolean) => void)[];
  closed: ((event: { code: number; reason: string }) => void)[];
};

function syncFrame(subtype: number, payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, subtype);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

const STEP2 = 1;
const UPDATE = 2;

/**
 * Stands in for y-websocket's provider in tests, and lets a test play the
 * sync server: deliver the stored document, drop the connection, close with
 * a code, or apply a collaborator's edit.
 *
 * It reports its "socket" traffic to the tap, as the real provider's
 * WebSocket does, so the server's confirmations work: local edits made
 * while connected are "sent"; the tab's confirmation probes collect in
 * `probes` until answerProbes() answers them.
 */
export class FakeProvider implements Provider {
  awareness: Awareness;
  params: Record<string, string>;
  connects = 0;
  disconnects = 0;
  destroyed = false;
  /** Probes (sync step 1) this tab sent that the "server" hasn't answered yet. */
  probes: Uint8Array[] = [];
  private socket: object | null = null;
  private handlers: Handlers = { status: [], sync: [], closed: [] };

  constructor(
    readonly serverUrl: string,
    readonly room: string,
    readonly doc: Y.Doc,
    ticket: string,
    private readonly tap: WireTap,
  ) {
    this.awareness = new Awareness(doc);
    this.params = { ticket };
    // Like the provider: local edits go out at once while connected.
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== this && this.socket) this.tap.sent(this.socket, syncFrame(UPDATE, update));
    });
  }

  on(event: "status", handler: (event: { status: string }) => void): void;
  on(event: "sync", handler: (synced: boolean) => void): void;
  on(event: "closed", handler: (event: { code: number; reason: string }) => void): void;
  on(event: keyof Handlers, handler: (arg: never) => void): void {
    (this.handlers[event] as ((arg: never) => void)[]).push(handler);
  }

  connect() {
    this.connects++;
  }
  disconnect() {
    this.disconnects++;
  }
  destroy() {
    this.destroyed = true;
    this.awareness.destroy();
  }

  /**
   * Connects and plays the whole handshake: the tab sends its step 1 and,
   * answering the server's step 1, everything the server lacks; the
   * server's copy arrives (as the provider applies it: origin = provider);
   * and, unless `confirm` is false, the server confirms what the tab sent.
   */
  serve(state?: Uint8Array, { confirm = true }: { confirm?: boolean } = {}) {
    const socket = {};
    this.socket = socket;
    this.tap.opened(socket, (frame) => {
      this.tap.sent(socket, frame);
      this.probes.push(frame);
    });
    this.tap.sent(socket, syncStep1Frame(this.doc));
    this.tap.sent(socket, syncFrame(STEP2, Y.encodeStateAsUpdate(this.doc)));
    if (state) Y.applyUpdate(this.doc, state, this);
    this.tap.received(socket, syncFrame(STEP2, new Uint8Array([0, 0])));
    this.handlers.status.forEach((h) => h({ status: "connected" }));
    this.handlers.sync.forEach((h) => h(true));
    if (confirm) {
      // A step 1 sent after everything, answered: everything is confirmed.
      this.tap.sent(socket, syncStep1Frame(this.doc));
      this.tap.received(socket, syncFrame(STEP2, new Uint8Array([0, 0])));
    }
  }

  /** The server answers every probe the tab has sent. */
  answerProbes() {
    if (!this.socket) return;
    const count = this.probes.length;
    this.probes = [];
    for (let i = 0; i < count; i++) {
      this.tap.received(this.socket, syncFrame(STEP2, new Uint8Array([0, 0])));
    }
  }

  /** A collaborator's edit arrives. */
  remote(update: Uint8Array) {
    Y.applyUpdate(this.doc, update, this);
  }

  drop() {
    if (this.socket) this.tap.closed(this.socket);
    this.socket = null;
    this.probes = [];
    this.handlers.status.forEach((h) => h({ status: "disconnected" }));
    this.handlers.sync.forEach((h) => h(false));
  }

  close(code: number) {
    this.drop();
    this.handlers.closed.forEach((h) => h({ code, reason: "" }));
  }
}

export function fakeProviders() {
  const created: FakeProvider[] = [];
  const factory: ProviderFactory = (serverUrl, room, doc, ticket, tap) => {
    const provider = new FakeProvider(serverUrl, room, doc, ticket, tap);
    created.push(provider);
    return provider;
  };
  return { created, factory, latest: () => created[created.length - 1] };
}
