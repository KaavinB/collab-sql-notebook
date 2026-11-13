import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import type { Provider, ProviderFactory } from "@/lib/notebook/sync";

type Handlers = {
  status: ((event: { status: string }) => void)[];
  sync: ((synced: boolean) => void)[];
  closed: ((event: { code: number; reason: string }) => void)[];
};

/**
 * Stands in for y-websocket's provider in tests, and lets a test play the
 * sync server: deliver the stored document, drop the connection, close with
 * a code, or apply a collaborator's edit.
 */
export class FakeProvider implements Provider {
  awareness: Awareness;
  params: Record<string, string>;
  connects = 0;
  destroyed = false;
  private handlers: Handlers = { status: [], sync: [], closed: [] };

  constructor(
    readonly serverUrl: string,
    readonly room: string,
    readonly doc: Y.Doc,
    ticket: string,
  ) {
    this.awareness = new Awareness(doc);
    this.params = { ticket };
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
  disconnect() {}
  destroy() {
    this.destroyed = true;
    this.awareness.destroy();
  }

  /** The server's copy arrives (as the provider applies it: origin = provider). */
  serve(state?: Uint8Array) {
    if (state) Y.applyUpdate(this.doc, state, this);
    this.handlers.status.forEach((h) => h({ status: "connected" }));
    this.handlers.sync.forEach((h) => h(true));
  }

  /** A collaborator's edit arrives. */
  remote(update: Uint8Array) {
    Y.applyUpdate(this.doc, update, this);
  }

  drop() {
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
  const factory: ProviderFactory = (serverUrl, room, doc, ticket) => {
    const provider = new FakeProvider(serverUrl, room, doc, ticket);
    created.push(provider);
    return provider;
  };
  return { created, factory, latest: () => created[created.length - 1] };
}
