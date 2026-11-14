/**
 * Sample bookkeeping: how an edit carries its identity and send time, how
 * receipts are stored, and how they are sorted into warm-up, measured and
 * missing.
 *
 * Every simulated keystroke inserts a stamp "<sender>:<seq>:<sentAtUs>;" at
 * the end of the sender's own cell. Any receiver can read who sent it, which
 * edit it was and when, from the edit itself, and compute the latency on
 * the same clock (all clients run on one machine; see clock.ts). A stamp is
 * about 20 characters (more as the counters grow), so an edit is about that
 * much larger than a one-character keystroke; the report says so and gives
 * the measured mean bytes per message.
 */

/** Matches one stamp. Bounded digit counts, so garbage can't make huge numbers. */
const STAMP = /(\d{1,6}):(\d{1,9}):(\d{1,17});/g;

export interface Stamp {
  sender: number;
  seq: number;
  sentAtUs: number;
}

export function encodeStamp(stamp: Stamp): string {
  if (
    !Number.isSafeInteger(stamp.sender) ||
    stamp.sender < 0 ||
    stamp.sender > 999_999 ||
    !Number.isSafeInteger(stamp.seq) ||
    stamp.seq < 0 ||
    stamp.seq > 999_999_999 ||
    !Number.isSafeInteger(stamp.sentAtUs) ||
    stamp.sentAtUs < 0
  ) {
    throw new RangeError(`stamp out of range: ${JSON.stringify(stamp)}`);
  }
  return `${stamp.sender}:${stamp.seq}:${stamp.sentAtUs};`;
}

/** Every stamp in `text` (an inserted string may hold several if updates were merged). */
export function parseStamps(text: string): Stamp[] {
  const stamps: Stamp[] = [];
  for (const match of text.matchAll(STAMP)) {
    stamps.push({ sender: Number(match[1]), seq: Number(match[2]), sentAtUs: Number(match[3]) });
  }
  return stamps;
}

/**
 * Receipts as growable typed columns: compact in memory and cheap to move
 * from a worker thread (the buffers are transferred, not copied).
 */
export class ReceiptColumns {
  length = 0;
  sender: Int32Array;
  seq: Int32Array;
  receiver: Int32Array;
  sentAtUs: Float64Array;
  receivedAtUs: Float64Array;

  constructor(capacity = 1024) {
    this.sender = new Int32Array(capacity);
    this.seq = new Int32Array(capacity);
    this.receiver = new Int32Array(capacity);
    this.sentAtUs = new Float64Array(capacity);
    this.receivedAtUs = new Float64Array(capacity);
  }

  push(sender: number, seq: number, receiver: number, sentAtUs: number, receivedAtUs: number) {
    if (this.length === this.sender.length) this.grow();
    const i = this.length++;
    this.sender[i] = sender;
    this.seq[i] = seq;
    this.receiver[i] = receiver;
    this.sentAtUs[i] = sentAtUs;
    this.receivedAtUs[i] = receivedAtUs;
  }

  private grow(): void {
    const capacity = Math.max(1024, this.sender.length * 2);
    const growInt = (old: Int32Array) => {
      const next = new Int32Array(capacity);
      next.set(old);
      return next;
    };
    const growFloat = (old: Float64Array) => {
      const next = new Float64Array(capacity);
      next.set(old);
      return next;
    };
    this.sender = growInt(this.sender);
    this.seq = growInt(this.seq);
    this.receiver = growInt(this.receiver);
    this.sentAtUs = growFloat(this.sentAtUs);
    this.receivedAtUs = growFloat(this.receivedAtUs);
  }

  /** Appends every receipt of `other`. */
  append(other: ReceiptColumns): void {
    for (let i = 0; i < other.length; i++) {
      this.push(
        other.sender[i]!,
        other.seq[i]!,
        other.receiver[i]!,
        other.sentAtUs[i]!,
        other.receivedAtUs[i]!,
      );
    }
  }

  /** A plain object for postMessage, with its buffers listed for transfer. */
  toMessage(): { message: ReceiptMessage; transfer: ArrayBuffer[] } {
    const trim = <T extends Int32Array | Float64Array>(column: T): T =>
      column.slice(0, this.length) as T;
    const message: ReceiptMessage = {
      length: this.length,
      sender: trim(this.sender),
      seq: trim(this.seq),
      receiver: trim(this.receiver),
      sentAtUs: trim(this.sentAtUs),
      receivedAtUs: trim(this.receivedAtUs),
    };
    const transfer = [
      message.sender.buffer,
      message.seq.buffer,
      message.receiver.buffer,
      message.sentAtUs.buffer,
      message.receivedAtUs.buffer,
    ] as ArrayBuffer[];
    return { message, transfer };
  }

  static fromMessage(message: ReceiptMessage): ReceiptColumns {
    const columns = new ReceiptColumns(0);
    columns.length = message.length;
    columns.sender = message.sender;
    columns.seq = message.seq;
    columns.receiver = message.receiver;
    columns.sentAtUs = message.sentAtUs;
    columns.receivedAtUs = message.receivedAtUs;
    return columns;
  }
}

export interface ReceiptMessage {
  length: number;
  sender: Int32Array;
  seq: Int32Array;
  receiver: Int32Array;
  sentAtUs: Float64Array;
  receivedAtUs: Float64Array;
}

/** When typing started, and the measured window [measureStartUs, measureEndUs). */
export interface TypingWindow {
  typingStartUs: number;
  measureStartUs: number;
  measureEndUs: number;
}

export type Phase = "warmup" | "measured" | "outside";

/** An edit's phase is decided by when it was sent, never by when it arrived. */
export function phaseOf(sentAtUs: number, window: TypingWindow): Phase {
  if (sentAtUs >= window.typingStartUs && sentAtUs < window.measureStartUs) return "warmup";
  if (sentAtUs >= window.measureStartUs && sentAtUs < window.measureEndUs) return "measured";
  return "outside";
}

/** Send times per sender, indexed by seq (seq counts from 0 with no gaps). */
export type SendLog = ReadonlyMap<number, ArrayLike<number>>;

export interface Tally {
  /** Latencies (ms) of measured deliveries, one per (sender, seq, receiver). */
  measuredMs: Float64Array;
  /** Deliveries of warm-up edits: received but excluded. */
  warmup: number;
  /** Measured deliveries that should have arrived: every observer, every other sender's measured edit. */
  expected: number;
  /** Expected measured deliveries that never arrived. */
  missing: number;
  /** A delivery seen again at the same receiver (counted once). */
  duplicates: number;
  /** Receipts that match no logged send, or whose stamp disagrees with the log. Excluded. */
  unknown: number;
  /** Receipts of edits sent outside the typing window. Excluded. */
  outside: number;
  /** Measured edits sent, over all senders. */
  measuredSends: number;
  /** Warm-up edits sent, over all senders. */
  warmupSends: number;
}

/**
 * Joins receipts against the send log for one run.
 *
 * `observers` are the clients whose receipts were recorded; each is expected
 * to receive every measured edit of every other sender (a client never
 * receives its own edits back).
 */
export function tally(
  receipts: ReceiptColumns,
  sends: SendLog,
  observers: Iterable<number>,
  window: TypingWindow,
): Tally {
  let measuredSends = 0;
  let warmupSends = 0;
  const measuredBySender = new Map<number, number>();
  for (const [sender, times] of sends) {
    let measured = 0;
    for (let seq = 0; seq < times.length; seq++) {
      const phase = phaseOf(times[seq]!, window);
      if (phase === "measured") measured++;
      else if (phase === "warmup") warmupSends++;
    }
    measuredBySender.set(sender, measured);
    measuredSends += measured;
  }

  let expected = 0;
  const observerSet = new Set(observers);
  for (const observer of observerSet) {
    expected += measuredSends - (measuredBySender.get(observer) ?? 0);
  }

  const seen = new Set<number>();
  const latencies: number[] = [];
  let warmup = 0;
  let duplicates = 0;
  let unknown = 0;
  let outside = 0;
  for (let i = 0; i < receipts.length; i++) {
    const sender = receipts.sender[i]!;
    const seq = receipts.seq[i]!;
    const receiver = receipts.receiver[i]!;
    const sentAtUs = receipts.sentAtUs[i]!;
    const logged = sends.get(sender);
    if (
      !observerSet.has(receiver) ||
      receiver === sender ||
      !logged ||
      seq >= logged.length ||
      logged[seq] !== sentAtUs
    ) {
      unknown++;
      continue;
    }
    // Unique per (sender, seq, receiver): senders and receivers are client
    // indexes below MAX_CLIENTS (2^12) and seq stays below MAX_SEQ (2^20)
    // (both enforced where clients are created and edits sent), so the key
    // stays under 2^44, well inside a double's exact integers.
    const key = (sender * 2 ** 20 + seq) * 2 ** 12 + receiver;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    const phase = phaseOf(sentAtUs, window);
    if (phase === "warmup") warmup++;
    else if (phase === "outside") outside++;
    else latencies.push((receipts.receivedAtUs[i]! - sentAtUs) / 1000);
  }

  return {
    measuredMs: Float64Array.from(latencies),
    warmup,
    expected,
    missing: expected - latencies.length,
    duplicates,
    unknown,
    outside,
    measuredSends,
    warmupSends,
  };
}

/** Limits that keep the packed key in `tally` unique. */
export const MAX_CLIENTS = 2 ** 12;
export const MAX_SEQ = 2 ** 20;
