import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import {
  DEFAULT_CONFIRMATION_TIMINGS,
  EditConfirmations,
  syncStep1Frame,
  trackingWebSocket,
} from "@/lib/notebook/confirmations";

const { probeDelayMs, overdueMs } = DEFAULT_CONFIRMATION_TIMINGS;

function frame(subtype: number, payload: Uint8Array = new Uint8Array([0, 0])): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, subtype);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}
const STEP2 = frame(1);
const UPDATE = frame(2);

afterEach(() => {
  vi.useRealTimers();
});

/** A tracker on its own, with the test playing both the provider and the server. */
function tracker() {
  const doc = new Y.Doc();
  const remote = Symbol("remote");
  const changes = vi.fn();
  const confirmations = new EditConfirmations(doc, (origin) => origin === remote, changes);
  const socket = {};
  const probes: Uint8Array[] = [];
  /** Opens the socket and completes the handshake (both step 1s answered). */
  const open = () => {
    confirmations.opened(socket, (data) => {
      confirmations.sent(socket, data);
      probes.push(data);
    });
    confirmations.sent(socket, syncStep1Frame(doc)); // the provider's, on open
    confirmations.sent(socket, STEP2); // answering the server's step 1
    confirmations.received(socket, STEP2); // the answer to ours
  };
  /** A local edit, sent at once as the provider does while connected. */
  const edit = (send = true) => {
    doc.getText("t").insert(0, "x");
    if (send) confirmations.sent(socket, UPDATE);
  };
  const answer = () => confirmations.received(socket, STEP2);
  return { doc, remote, confirmations, socket, probes, open, edit, answer, changes };
}

describe("EditConfirmations", () => {
  it("confirms sent edits with one probe after a burst of typing", () => {
    vi.useFakeTimers();
    const t = tracker();
    t.open();
    t.edit();
    t.edit();
    expect(t.confirmations.unconfirmed()).toBe(true);
    vi.advanceTimersByTime(probeDelayMs);
    expect(t.probes).toHaveLength(1);
    expect(t.probes[0]).toEqual(syncStep1Frame(t.doc));
    t.answer();
    expect(t.confirmations.unconfirmed()).toBe(false);
    expect(t.changes).toHaveBeenCalled();
  });

  it("keeps one probe in flight, and probes again for edits sent after it", () => {
    vi.useFakeTimers();
    const t = tracker();
    t.open();
    t.edit();
    vi.advanceTimersByTime(probeDelayMs);
    t.edit(); // sent after the probe: its answer doesn't cover this one
    vi.advanceTimersByTime(probeDelayMs * 3);
    expect(t.probes).toHaveLength(1);
    t.answer();
    expect(t.confirmations.unconfirmed()).toBe(true);
    vi.advanceTimersByTime(probeDelayMs);
    expect(t.probes).toHaveLength(2);
    t.answer();
    expect(t.confirmations.unconfirmed()).toBe(false);
  });

  it("doesn't count changes from the server", () => {
    const t = tracker();
    t.open();
    const other = new Y.Doc();
    other.getText("t").insert(0, "theirs");
    Y.applyUpdate(t.doc, Y.encodeStateAsUpdate(other), t.remote);
    expect(t.confirmations.unconfirmed()).toBe(false);
  });

  it("calls sent edits overdue when no answer comes (a dead connection that looks open)", () => {
    vi.useFakeTimers();
    const t = tracker();
    t.open();
    t.edit();
    vi.advanceTimersByTime(overdueMs - 1);
    expect(t.confirmations.overdue()).toBe(false);
    t.changes.mockClear();
    vi.advanceTimersByTime(1);
    expect(t.confirmations.overdue()).toBe(true);
    expect(t.changes).toHaveBeenCalledTimes(1); // the page re-renders to show it
    t.answer();
    expect(t.confirmations.overdue()).toBe(false);
  });

  it("doesn't call edits made offline overdue: they aren't sent yet", () => {
    vi.useFakeTimers();
    const t = tracker();
    t.edit(false);
    vi.advanceTimersByTime(overdueMs * 2);
    expect(t.confirmations.unconfirmed()).toBe(true);
    expect(t.confirmations.overdue()).toBe(false);
  });

  it("forgets what a closed socket sent; a new socket must deliver and confirm it again", () => {
    vi.useFakeTimers();
    const t = tracker();
    t.open();
    t.edit();
    vi.advanceTimersByTime(probeDelayMs); // probe sent, never answered
    t.confirmations.closed(t.socket);
    expect(t.confirmations.overdue()).toBe(false);
    // Reconnect: the provider sends step 1 at once; the server's step 2
    // answering it arrives before our step 2 (the offline edits) was
    // applied, so it confirms nothing; the probe after it does.
    const next = {};
    const probes: Uint8Array[] = [];
    t.confirmations.opened(next, (data) => {
      t.confirmations.sent(next, data);
      probes.push(data);
    });
    t.confirmations.sent(next, syncStep1Frame(t.doc));
    t.confirmations.sent(next, STEP2); // answering the server's step 1
    t.confirmations.received(next, STEP2);
    expect(t.confirmations.unconfirmed()).toBe(true);
    vi.advanceTimersByTime(probeDelayMs);
    expect(probes).toHaveLength(1);
    t.confirmations.received(next, STEP2);
    expect(t.confirmations.unconfirmed()).toBe(false);
  });

  it("never confirms offline edits with a probe sent before the handshake's step 2", () => {
    vi.useFakeTimers();
    const t = tracker();
    t.edit(false); // made offline
    // Reconnect. On the wire: our step 1, then an edit typed at once (sent
    // as an update), then a probe, while the server's step 1 is still on its
    // way, so our step 2 with the offline edit hasn't been sent.
    const next = {};
    const probes: Uint8Array[] = [];
    t.confirmations.opened(next, (data) => {
      t.confirmations.sent(next, data);
      probes.push(data);
    });
    t.confirmations.sent(next, syncStep1Frame(t.doc));
    t.doc.getText("t").insert(0, "typed");
    t.confirmations.sent(next, UPDATE);
    vi.advanceTimersByTime(probeDelayMs * 2);
    // Whatever was asked so far is answered (the server got the update)...
    t.confirmations.received(next, STEP2);
    probes.forEach(() => t.confirmations.received(next, STEP2));
    expect(t.confirmations.unconfirmed()).toBe(true);
    // ...then the socket dies before our step 2 arrives: still unconfirmed,
    // so the page says so and the connection isn't let go.
    t.confirmations.closed(next);
    expect(t.confirmations.unconfirmed()).toBe(true);
  });

  it("confirms edits typed during the handshake once its step 2 has gone out", () => {
    vi.useFakeTimers();
    const t = tracker();
    t.edit(false);
    const next = {};
    const probes: Uint8Array[] = [];
    t.confirmations.opened(next, (data) => {
      t.confirmations.sent(next, data);
      probes.push(data);
    });
    t.confirmations.sent(next, syncStep1Frame(t.doc));
    t.doc.getText("t").insert(0, "typed");
    t.confirmations.sent(next, UPDATE);
    t.confirmations.sent(next, STEP2); // the offline edit leaves
    t.confirmations.received(next, STEP2); // answers our first step 1 only
    expect(t.confirmations.unconfirmed()).toBe(true);
    vi.advanceTimersByTime(probeDelayMs);
    expect(probes).toHaveLength(1);
    t.confirmations.received(next, STEP2);
    expect(t.confirmations.unconfirmed()).toBe(false);
  });

  it("ignores frames from an old socket", () => {
    vi.useFakeTimers();
    const t = tracker();
    t.open();
    t.edit();
    t.confirmations.opened({}, () => {}); // reconnected on a new socket
    t.confirmations.received(t.socket, STEP2); // late answer on the old one
    expect(t.confirmations.unconfirmed()).toBe(true);
  });

  it("ignores an answer nobody asked for, and messages that aren't sync step 2", () => {
    const t = tracker();
    t.open();
    t.edit();
    t.answer();
    t.confirmations.received(t.socket, new Uint8Array([1, 0]));
    t.confirmations.received(t.socket, new Uint8Array([0xff]));
    expect(t.confirmations.unconfirmed()).toBe(true);
  });
});

// --- With the real provider ----------------------------------------------

/**
 * A WebSocket whose other end is a sync server in memory: a Y.Doc that
 * answers step 1 with step 2, sends its own step 1 first (as ours does for
 * editors) and applies updates. In `blackHole` mode the network silently
 * swallows everything, like a half-open connection.
 */
class ServerSocket extends EventTarget {
  static server = new Y.Doc();
  static blackHole = false;
  static sockets: ServerSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  binaryType = "arraybuffer";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    super();
    ServerSocket.sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.fire("open", new Event("open"));
      this.deliver(this.serverFrame((e) => syncProtocol.writeSyncStep1(e, ServerSocket.server)));
    });
  }

  private fire(type: "open" | "message" | "close", event: Event) {
    this.dispatchEvent(event);
    const handler = this[`on${type}`] as ((event: Event) => void) | null;
    handler?.(event);
  }

  private serverFrame(write: (encoder: encoding.Encoder) => void): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    write(encoder);
    return encoding.toUint8Array(encoder);
  }

  private deliver(data: Uint8Array) {
    if (ServerSocket.blackHole || this.readyState !== 1) return;
    const copy = data.slice().buffer;
    queueMicrotask(() => {
      if (this.readyState === 1) this.fire("message", new MessageEvent("message", { data: copy }));
    });
  }

  send(data: Uint8Array) {
    if (ServerSocket.blackHole || this.readyState !== 1) return;
    const decoder = decoding.createDecoder(data);
    if (decoding.readVarUint(decoder) !== 0) return; // awareness: not needed here
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, 0);
    syncProtocol.readSyncMessage(decoder, reply, ServerSocket.server, "client");
    if (encoding.length(reply) > 1) this.deliver(encoding.toUint8Array(reply));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.fire("close", Object.assign(new Event("close"), { code: 1006 })));
  }
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("trackingWebSocket with y-websocket's provider", () => {
  afterEach(() => {
    ServerSocket.server = new Y.Doc();
    ServerSocket.blackHole = false;
    ServerSocket.sockets = [];
  });

  function connect(doc: Y.Doc) {
    let provider: WebsocketProvider | null = null;
    const confirmations = new EditConfirmations(
      doc,
      (origin) => origin === provider,
      () => {},
      { probeDelayMs: 5, overdueMs: 50 },
    );
    provider = new WebsocketProvider("ws://sync.test/notebooks", "nb", doc, {
      disableBc: true,
      WebSocketPolyfill: trackingWebSocket(
        confirmations,
        ServerSocket as unknown as typeof WebSocket,
      ),
    });
    return { provider, confirmations };
  }

  it("confirms typed edits once the server has them", async () => {
    const doc = new Y.Doc();
    const { provider, confirmations } = connect(doc);
    await vi.waitFor(() => expect(provider.synced).toBe(true));
    doc.getText("t").insert(0, "hello");
    expect(confirmations.unconfirmed()).toBe(true);
    await vi.waitFor(() => expect(confirmations.unconfirmed()).toBe(false));
    expect(ServerSocket.server.getText("t").toString()).toBe("hello");
    provider.destroy();
  });

  it("confirms offline edits only after the reconnect delivered them", async () => {
    const doc = new Y.Doc();
    const { provider, confirmations } = connect(doc);
    await vi.waitFor(() => expect(provider.synced).toBe(true));
    provider.disconnect();
    doc.getText("t").insert(0, "offline");
    provider.connect();
    await vi.waitFor(() => expect(provider.synced).toBe(true));
    await vi.waitFor(() => expect(confirmations.unconfirmed()).toBe(false));
    expect(ServerSocket.server.getText("t").toString()).toBe("offline");
    provider.destroy();
  });

  it("calls edits overdue on a connection that swallows them", async () => {
    const doc = new Y.Doc();
    const { provider, confirmations } = connect(doc);
    await vi.waitFor(() => expect(provider.synced).toBe(true));
    ServerSocket.blackHole = true;
    doc.getText("t").insert(0, "lost");
    await settle();
    expect(provider.wsconnected).toBe(true); // the provider hasn't noticed
    await vi.waitFor(() => expect(confirmations.overdue()).toBe(true));
    expect(ServerSocket.server.getText("t").toString()).toBe("");
    // A new connection delivers and confirms them.
    ServerSocket.blackHole = false;
    provider.disconnect();
    provider.connect();
    await vi.waitFor(() => expect(confirmations.unconfirmed()).toBe(false));
    expect(ServerSocket.server.getText("t").toString()).toBe("lost");
    provider.destroy();
  });
});
