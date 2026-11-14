/**
 * Knowing when the sync server has this tab's edits.
 *
 * The sync protocol has no acknowledgements: the provider sends an edit and
 * never hears whether it arrived. A socket can die without either side
 * noticing (a laptop changing networks leaves it half-open), and the
 * provider's watchdog only gives up on it after 30 seconds without a
 * message. Edits typed in that window look sent but are lost with the socket.
 *
 * The confirmation uses the protocol's own messages, so the server needs no
 * change. Whenever this tab sends "sync step 1" (its state vector: "what am
 * I missing?"), the server answers with exactly one "sync step 2". It
 * handles each socket's messages one at a time, in order, so by the time it
 * answers a step 1 it has already applied everything this tab sent before
 * that step 1. An answered step 1 therefore confirms every edit sent ahead
 * of it.
 *
 * So the tracker counts local edits, notes how many had been sent when each
 * step 1 went out, and when an answer comes back, marks that many as
 * confirmed. The provider sends one step 1 when a socket opens; after edits
 * are sent, the tracker sends its own (a "probe"), at most one at a time and
 * a short while after the last edit, so a burst of typing costs one round
 * trip. The answer to a probe also carries whatever the tab is missing,
 * which is harmless (Yjs ignores what it already has).
 *
 * It watches the socket itself (trackingWebSocket wraps the WebSocket class
 * the provider uses), so it sees exactly what went over the wire, in order,
 * whatever the provider does internally.
 *
 * Edits are "overdue" when some were sent and haven't been confirmed for
 * OVERDUE_MS: the connection is probably dead even though it looks open.
 * Edits made while disconnected aren't overdue, they're simply offline; the
 * page says so from the connection's status.
 *
 * Edits made offline leave only in the step 2 that answers the server's
 * step 1 when a socket connects. Until a socket has sent that step 2, the
 * updates it sends don't count as carrying everything, so nothing made
 * offline can be confirmed before it has actually been sent.
 *
 * Viewers: the server never sends a viewer its step 1, so a viewer's edits
 * are never counted as sent or confirmed, which is right, since the server
 * drops them. The notebook page never lets a viewer edit, and a role drop
 * with unconfirmed edits is handled in sync.ts.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";

const MESSAGE_SYNC = 0;
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

export interface ConfirmationTimings {
  /** How long after edits are sent the probe goes out (a burst of typing shares one). */
  probeDelayMs: number;
  /** Sent edits unconfirmed for this long are overdue (the connection is likely dead). */
  overdueMs: number;
}

export const DEFAULT_CONFIRMATION_TIMINGS: ConfirmationTimings = {
  probeDelayMs: 300,
  // Several round trips on a slow network, and well under the provider's
  // 30 s watchdog.
  overdueMs: 3_000,
};

// Sent edits are grouped into windows of this length for timing, so the
// bookkeeping stays small however fast someone types. An overdue warning can
// come up to this much early, which only matters next to OVERDUE_MS.
const SEND_WINDOW_MS = 500;

/** What the WebSocket wrapper reports. `socket` tells apart old and new connections. */
export interface WireTap {
  /** A socket opened; `send` writes a frame on it (used for probes). */
  opened(socket: object, send: (frame: Uint8Array) => void): void;
  /** A frame is about to be written on the socket. */
  sent(socket: object, frame: Uint8Array): void;
  /** A frame arrived on the socket. */
  received(socket: object, frame: Uint8Array): void;
  /** The socket closed (or failed). */
  closed(socket: object): void;
}

/** The sync message's subtype, or null for any other message (or garbage). */
function syncSubtype(frame: Uint8Array): number | null {
  try {
    const decoder = decoding.createDecoder(frame);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return null;
    return decoding.readVarUint(decoder);
  } catch {
    return null;
  }
}

export function syncStep1Frame(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarUint(encoder, SYNC_STEP1);
  encoding.writeVarUint8Array(encoder, Y.encodeStateVector(doc));
  return encoding.toUint8Array(encoder);
}

export class EditConfirmations implements WireTap {
  /** Local edits made so far (a counter: edit n is the n-th). */
  private made = 0;
  /** Edits sent on the current socket, or before it and confirmed. */
  private sent_ = 0;
  /** Edits the server confirmed. */
  private confirmed = 0;
  /** Highest count an outstanding step 1 will confirm when answered. */
  private covered = 0;
  /** Outstanding step 1s on the current socket, oldest first, with the count each confirms. */
  private waiting: { count: number; probe: boolean }[] = [];
  /** When sent edits went out, by window: [count sent by the window's end, when it started]. */
  private sendTimes: [number, number][] = [];
  private socket: object | null = null;
  /** This socket has sent its step 2 (the edits the server lacked when it connected). */
  private handshakeSent = false;
  private send: ((frame: Uint8Array) => void) | null = null;
  private sendingProbe = false;
  private probeInFlight = false;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private overdueTimer: ReturnType<typeof setTimeout> | null = null;
  private wasUnconfirmed = false;
  private wasOverdue = false;
  private destroyed = false;

  private readonly doc: Y.Doc;
  private readonly timings: ConfirmationTimings;
  private readonly onChange: () => void;
  private readonly now: () => number;

  /**
   * `isRemote` tells changes that arrived from the server (the provider
   * applies them) from this tab's own. The tracker must be created before
   * the provider, so it counts an edit before the provider sends it.
   */
  constructor(
    doc: Y.Doc,
    isRemote: (origin: unknown) => boolean,
    onChange: () => void,
    timings: Partial<ConfirmationTimings> = {},
    now: () => number = () => Date.now(),
  ) {
    this.doc = doc;
    this.onChange = onChange;
    this.timings = { ...DEFAULT_CONFIRMATION_TIMINGS, ...timings };
    this.now = now;
    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (!isRemote(origin)) this.edited();
    });
  }

  /** Some local edits haven't been confirmed by the server (sent or not). */
  unconfirmed(): boolean {
    return this.made > this.confirmed;
  }

  /** Some sent edits have gone unconfirmed for too long. */
  overdue(): boolean {
    const oldest = this.sendTimes[0];
    return oldest !== undefined && this.now() - oldest[1] >= this.timings.overdueMs;
  }

  // --- WireTap ----------------------------------------------------------

  opened(socket: object, send: (frame: Uint8Array) => void): void {
    this.reset();
    this.socket = socket;
    this.send = send;
  }

  sent(socket: object, frame: Uint8Array): void {
    if (socket !== this.socket) return;
    const subtype = syncSubtype(frame);
    if (subtype === SYNC_STEP1) {
      this.waiting.push({ count: this.sent_, probe: this.sendingProbe });
      this.covered = Math.max(this.covered, this.sent_);
    } else if (subtype === SYNC_STEP2 || subtype === SYNC_UPDATE) {
      // A step 2 (our answer to the server's step 1) carries every edit the
      // server lacks, so everything made so far is now on the wire. An update
      // carries only the edit just made: it counts as "everything" only once
      // this socket has sent its step 2. Before that, edits made while
      // offline haven't left yet, and a probe answered now must not confirm
      // them (if the socket then died, they'd be lost unnoticed).
      if (subtype === SYNC_STEP2) this.handshakeSent = true;
      if (this.handshakeSent && this.made > this.sent_) {
        this.sent_ = this.made;
        const last = this.sendTimes[this.sendTimes.length - 1];
        const at = this.now();
        if (last && at - last[1] < SEND_WINDOW_MS) last[0] = this.sent_;
        else this.sendTimes.push([this.sent_, at]);
        this.schedule();
      }
    }
  }

  received(socket: object, frame: Uint8Array): void {
    if (socket !== this.socket || syncSubtype(frame) !== SYNC_STEP2) return;
    const answered = this.waiting.shift();
    if (!answered) return; // the server never sends a step 2 unasked; ignore it
    if (answered.probe) this.probeInFlight = false;
    if (answered.count > this.confirmed) {
      this.confirmed = answered.count;
      while (this.sendTimes[0] && this.sendTimes[0][0] <= this.confirmed) this.sendTimes.shift();
    }
    this.schedule();
  }

  closed(socket: object): void {
    if (socket !== this.socket) return;
    this.reset();
    this.schedule();
  }

  destroy(): void {
    this.destroyed = true;
    this.reset();
    if (this.overdueTimer) clearTimeout(this.overdueTimer);
    this.overdueTimer = null;
  }

  // --- Internals --------------------------------------------------------

  private edited(): void {
    this.made++;
    this.schedule();
  }

  /** Forgets the socket: whatever was sent on it and not confirmed counts as unsent. */
  private reset(): void {
    this.socket = null;
    this.handshakeSent = false;
    this.send = null;
    this.waiting = [];
    this.sendTimes = [];
    this.sent_ = this.confirmed;
    this.covered = this.confirmed;
    this.probeInFlight = false;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
  }

  /** Plans the next probe and overdue check, and reports any change. */
  private schedule(): void {
    if (this.destroyed) return;
    if (
      this.send &&
      !this.probeInFlight &&
      !this.probeTimer &&
      this.sent_ > Math.max(this.covered, this.confirmed)
    ) {
      this.probeTimer = setTimeout(() => this.probe(), this.timings.probeDelayMs);
    }
    if (this.overdueTimer) clearTimeout(this.overdueTimer);
    this.overdueTimer = null;
    const oldest = this.sendTimes[0];
    if (oldest && !this.overdue()) {
      const wait = oldest[1] + this.timings.overdueMs - this.now();
      this.overdueTimer = setTimeout(() => this.schedule(), Math.max(0, wait));
    }
    const unconfirmed = this.unconfirmed();
    const overdue = this.overdue();
    if (unconfirmed !== this.wasUnconfirmed || overdue !== this.wasOverdue) {
      this.wasUnconfirmed = unconfirmed;
      this.wasOverdue = overdue;
      this.onChange();
    }
  }

  private probe(): void {
    this.probeTimer = null;
    const send = this.send;
    if (!send || this.probeInFlight || this.sent_ <= Math.max(this.covered, this.confirmed)) {
      return;
    }
    this.sendingProbe = true;
    try {
      send(syncStep1Frame(this.doc));
    } finally {
      this.sendingProbe = false;
    }
    this.probeInFlight = true;
  }
}

/**
 * A WebSocket class for the provider that reports every frame to `tap`.
 * Everything else is the browser's WebSocket (or `Base`, in tests).
 */
export function trackingWebSocket(
  tap: WireTap,
  Base: typeof WebSocket = WebSocket,
): typeof WebSocket {
  return class TrackedWebSocket extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      // Registered before the provider sets onopen/onmessage, so the tap
      // sees each event before the provider reacts to it (the provider
      // sends its step 1 from onopen).
      this.addEventListener("open", () => tap.opened(this, (frame) => this.send(frame)));
      this.addEventListener("message", (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) tap.received(this, new Uint8Array(event.data));
      });
      this.addEventListener("close", () => tap.closed(this));
    }

    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (data instanceof Uint8Array) tap.sent(this, data);
      else if (data instanceof ArrayBuffer) tap.sent(this, new Uint8Array(data));
      super.send(data);
    }
  };
}
