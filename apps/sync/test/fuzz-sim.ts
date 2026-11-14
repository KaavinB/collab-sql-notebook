/**
 * The machinery behind fuzz.test.ts: simulated clients, fake sockets, a
 * seeded scheduler and the end-state checks. See fuzz.test.ts for what the
 * test covers and its knobs.
 *
 * The server side is the real thing: RoomManager, Room, Connection and the
 * Postgres Store (wrapped to fail some calls on purpose). Only the network is
 * fake. Each connection is a pair of FIFO queues, one per direction, so a
 * socket stays ordered like TCP, while the scheduler picks which socket moves
 * next, so messages across clients arrive in random order.
 *
 * The clients speak the same messages y-websocket's provider does (sync step
 * 1/2, updates, awareness), built with y-protocols, but driven by the
 * scheduler instead of timers so a seed decides everything they do.
 */
import { EventEmitter } from "node:events";

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type pg from "pg";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type { WebSocket } from "ws";
import * as Y from "yjs";

import type { Connection } from "../src/connection.ts";
import { log } from "../src/log.ts";
import { MESSAGE_AWARENESS, MESSAGE_SYNC } from "../src/protocol.ts";
import type { Room } from "../src/room.ts";
import { DEFAULT_MANAGER_TIMINGS, RoomManager, type ManagerTimings } from "../src/rooms.ts";
import { Store, type CompactResult, type LoadedDocument } from "../src/store.ts";
import type { Role } from "../src/ticket.ts";

// --- Seeded randomness --------------------------------------------------

/** mulberry32: tiny, fast, and the same sequence on every machine for a seed. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from an empty list");
    return items[this.int(items.length)]!;
  }

  hex(length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += this.int(16).toString(16);
    return out;
  }

  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20)}`;
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }
}

// --- A store that fails on purpose ---------------------------------------

type StoreCall = "load" | "memberRole" | "append" | "compact";
const STORE_CALLS: readonly StoreCall[] = ["load", "memberRole", "append", "compact"];

/**
 * The real Store, except that some calls fail: before touching Postgres
 * (nothing written), or after (written, but the caller is told it failed, as
 * when a connection drops before the COMMIT reply arrives).
 *
 * Whether a call fails depends only on the seed, the kind of call and how
 * many calls of that kind came before it: the n-th load of a run fails or
 * not whatever the timing. Loads and membership checks happen at fixed
 * points of the schedule, so their failures replay exactly. Appends and
 * compactions happen whenever the batching timers fire, so which of them
 * fails can differ between runs of a seed; clients never see those (a failed
 * write is retried), except at a crash or restart, where the run turns
 * failures off (see FuzzRun).
 */
export class FlakyStore extends Store {
  enabled = true;
  loads = 0;
  compactions = 0;
  appends = 0;
  injected = 0;
  private readonly calls = new Map<StoreCall, number>();
  private readonly seed: number;
  private readonly rate: number;

  constructor(pool: pg.Pool, seed: number, rate: number) {
    super(pool);
    this.seed = seed;
    this.rate = rate;
  }

  /** "before" (fail without writing), "after" (write, then fail) or null. */
  private trip(kind: StoreCall): "before" | "after" | null {
    const n = this.calls.get(kind) ?? 0;
    this.calls.set(kind, n + 1);
    if (!this.enabled || this.rate <= 0) return null;
    const key = (this.seed * 31 + STORE_CALLS.indexOf(kind)) * 1_000_003 + n;
    const roll = new Rng((key >>> 0) ^ Math.floor(key / 2 ** 32)).next();
    if (roll < this.rate / 2) return "before";
    if (roll < this.rate) return "after";
    return null;
  }

  private fail(what: string): never {
    this.injected++;
    throw new Error(`injected ${what} failure`);
  }

  override async load(notebookId: string): Promise<LoadedDocument | null> {
    if (this.trip("load")) this.fail("load");
    const loaded = await super.load(notebookId);
    this.loads++;
    return loaded;
  }

  /** While set, membership checks wait for it (see FuzzRun.connect). */
  memberRoleGate: Promise<void> | null = null;

  override async memberRole(notebookId: string, userId: string): Promise<Role | null> {
    if (this.memberRoleGate) await this.memberRoleGate;
    if (this.trip("memberRole")) this.fail("membership");
    return super.memberRole(notebookId, userId);
  }

  override async append(notebookId: string, update: Uint8Array): Promise<void> {
    const trip = this.trip("append");
    if (trip === "before") this.fail("append");
    await super.append(notebookId, update);
    this.appends++;
    if (trip === "after") this.fail("append reply");
  }

  /** While set, compactions wait for it (holds an unload in the middle; see FuzzRun). */
  compactGate: Promise<void> | null = null;

  override async compact(notebookId: string): Promise<CompactResult> {
    if (this.compactGate) await this.compactGate;
    const trip = this.trip("compact");
    if (trip === "before") this.fail("compact");
    const result = await super.compact(notebookId);
    if (result.mergedRows > 0) this.compactions++;
    if (trip === "after") this.fail("compact reply");
    return result;
  }
}

// --- Fake network --------------------------------------------------------

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/**
 * What the server sees as the client's WebSocket: the parts of `ws` that
 * RoomManager and Connection use. Sends land in the link's queue to the
 * client; the scheduler delivers the client's messages with emit("message").
 */
class FakeServerSocket extends EventEmitter {
  readonly OPEN = OPEN;
  readyState = OPEN;
  bufferedAmount = 0;
  private readonly link: Link;

  constructor(link: Link) {
    super();
    this.link = link;
  }

  send(data: Uint8Array): void {
    if (this.readyState !== OPEN) return;
    this.link.toClient.push(Uint8Array.from(data));
  }

  /** The server closes: the client learns of it after the messages sent before. */
  close(code = 1005): void {
    if (this.readyState !== OPEN) return;
    this.readyState = CLOSING;
    this.link.closeCode = code;
    // ws reports the close once the closing handshake ends, never in the
    // middle of the call that started it.
    setImmediate(() => this.finish(code));
  }

  /** The socket is gone (closed handshake done, or the network dropped). */
  finish(code: number): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit("close", code);
  }
}

/** One connection: a socket per side and an ordered queue per direction. */
class Link {
  static nextId = 1;
  readonly id = Link.nextId++;
  readonly toServer: Uint8Array[] = [];
  readonly toClient: Uint8Array[] = [];
  /** Close code the server sent, delivered to the client after toClient drains. */
  closeCode: number | null = null;
  /** The network dropped it: nothing more moves either way. */
  broken = false;
  /** Scheduler steps before this socket may move again (a slow connection). */
  stalledUntil = 0;
  readonly ws: FakeServerSocket;
  readonly client: SimClient;

  constructor(client: SimClient) {
    this.client = client;
    this.ws = new FakeServerSocket(this);
  }
}

// --- Simulated client ----------------------------------------------------

function syncFrame(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

function awarenessFrame(awareness: awarenessProtocol.Awareness): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
  );
  return encoding.toUint8Array(encoder);
}

export interface Member {
  userId: string;
  name: string;
  role: Role;
}

/**
 * A browser tab: its own replica of the document, which it keeps editing
 * whether or not it's connected, like the notebook page does.
 */
export class SimClient {
  readonly doc = new Y.Doc();
  readonly awareness: awarenessProtocol.Awareness;
  link: Link | null = null;
  synced = false;
  readonly label: string;
  readonly member: Member;
  private readonly problems: string[];

  constructor(label: string, member: Member, clientId: number, problems: string[]) {
    this.label = label;
    this.member = member;
    this.problems = problems;
    // Fixed per seed, so ties between concurrent inserts break the same way
    // on a replay.
    this.doc.clientID = clientId;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState({ user: { name: member.name }, cursor: null });
    // Like the provider: every local change goes out at once while connected.
    // Changes received from the server carry this client as their origin.
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this || !this.link) return;
      this.link.toServer.push(syncFrame((e) => syncProtocol.writeUpdate(e, update)));
    });
  }

  get isViewer(): boolean {
    return this.member.role === "viewer";
  }

  /** Handles one message from the server, as y-websocket's provider does. */
  receive(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MESSAGE_SYNC);
      const subtype = syncProtocol.readSyncMessage(decoder, reply, this.doc, this, (error) =>
        this.problems.push(`${this.label} could not apply an update: ${error.message}`),
      );
      if (subtype === syncProtocol.messageYjsSyncStep2) this.synced = true;
      if (encoding.length(reply) > 1) this.link?.toServer.push(encoding.toUint8Array(reply));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        this,
      );
    } else {
      this.problems.push(`${this.label} got an unexpected message type ${type}`);
    }
  }

  /** Points the cursor somewhere in a cell's text and announces it. */
  moveCursor(text: Y.Text, index: number): void {
    const position = Y.createRelativePositionFromTypeIndex(text, index);
    this.awareness.setLocalStateField("cursor", { anchor: position, head: position });
    this.link?.toServer.push(awarenessFrame(this.awareness));
  }

  destroy(): void {
    this.awareness.destroy();
    this.doc.destroy();
  }
}

// --- The document's shape and random edits --------------------------------

const CELL_TYPES = ["sql", "markdown", "chart"] as const;
// Plain letters plus characters that are more than one byte in UTF-8 and,
// for the emoji, two UTF-16 code units (Y.Text indexes count code units).
const CHARS = "abcdefgh SELECT*,()'\né✓😀";

function randomText(rng: Rng, maxLength: number): string {
  const chars = [...CHARS];
  let out = "";
  const length = 1 + rng.int(maxLength);
  for (let i = 0; i < length; i++) out += rng.pick(chars);
  return out;
}

function cellsOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>("cells");
}

/** Cell IDs, sorted: a map's key order can differ between replicas. */
function cellIds(doc: Y.Doc): string[] {
  return [...cellsOf(doc).keys()].sort();
}

function cellMap(doc: Y.Doc, id: string): Y.Map<unknown> | null {
  const cell = cellsOf(doc).get(id);
  return cell instanceof Y.Map ? cell : null;
}

function textOf(doc: Y.Doc, id: string): Y.Text | null {
  const source = cellMap(doc, id)?.get("source");
  return source instanceof Y.Text ? source : null;
}

/** A cell shaped like the web app's (apps/web/src/lib/notebook/doc.ts). */
function newCell(rng: Rng, type: (typeof CELL_TYPES)[number]): Y.Map<unknown> {
  const cell = new Y.Map<unknown>();
  cell.set("type", type);
  cell.set("order", `a${rng.hex(3)}`);
  if (type === "chart") {
    const chart = new Y.Map<unknown>();
    chart.set("source", null);
    chart.set("mark", "bar");
    cell.set("chart", chart);
  } else {
    const source = new Y.Text();
    source.insert(0, randomText(rng, 12));
    cell.set("source", source);
  }
  if (type === "sql") cell.set("lastRunId", null);
  return cell;
}

/** The starting document every run shares (stored as the snapshot). */
export function initialDocument(): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const rng = new Rng(0);
  doc.transact(() => {
    cellsOf(doc).set("seed-sql", newCell(rng, "sql"));
    cellsOf(doc).set("seed-md", newCell(rng, "markdown"));
  });
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

/**
 * Cells most edits go to. Without these, edits spread over every cell
 * created during a run, and late in a long run two clients rarely type into
 * the same text at once. IDs starting with "h" (and the starting cells) are
 * "hot"; about a third of new cells are hot, so there are always a few.
 */
function isHot(id: string): boolean {
  return id.startsWith("h") || id.startsWith("seed-");
}

/** One random local edit on the client's replica. Returns what it did. */
function randomEdit(rng: Rng, client: SimClient): string {
  const doc = client.doc;
  const ids = cellIds(doc);
  const texts = ids.filter((id) => textOf(doc, id) !== null);
  const roll = rng.next();
  if (ids.length === 0 || roll < 0.06) {
    const id = `${rng.chance(0.35) ? "h" : "c"}${rng.hex(6)}`;
    const type = rng.pick(CELL_TYPES);
    doc.transact(() => cellsOf(doc).set(id, newCell(rng, type)));
    return `add ${type} cell ${id}`;
  }
  if (roll < 0.09 && ids.length > 1) {
    const id = rng.pick(ids);
    doc.transact(() => cellsOf(doc).delete(id));
    return `delete cell ${id}`;
  }
  if (roll < 0.15) {
    const id = rng.pick(ids);
    const order = `a${rng.hex(1 + rng.int(4))}`;
    doc.transact(() => cellMap(doc, id)?.set("order", order));
    return `move cell ${id} to ${order}`;
  }
  if (roll < 0.21) {
    const id = rng.pick(ids);
    const cell = cellMap(doc, id);
    const chart = cell?.get("chart");
    if (chart instanceof Y.Map && rng.chance(0.6)) {
      const field = rng.pick(["mark", "x", "y", "aggregate", "source"]);
      const value = rng.pick(["bar", "line", "trips", "fare", null]);
      doc.transact(() => chart.set(field, value));
      return `set chart ${field} of ${id}`;
    }
    const runId = rng.chance(0.2) ? null : rng.uuid();
    doc.transact(() => cell?.set("lastRunId", runId));
    return `set lastRunId of ${id}`;
  }
  if (texts.length === 0) return "nothing to type in";
  const hot = texts.filter(isHot);
  const preferHot = rng.chance(0.75);
  const id = rng.pick(preferHot && hot.length > 0 ? hot : texts);
  const text = textOf(doc, id)!;
  const length = text.length;
  const kind =
    length > 300
      ? rng.pick(["delete", "replace"])
      : rng.pick(["insert", "insert", "delete", "replace"]);
  if (kind === "insert" || length === 0) {
    const at = rng.int(length + 1);
    const inserted = randomText(rng, 8);
    doc.transact(() => text.insert(at, inserted));
    return `insert ${inserted.length} at ${at} in ${id}`;
  }
  const at = rng.int(length);
  const count = 1 + rng.int(Math.min(length - at, 20));
  if (kind === "delete") {
    doc.transact(() => text.delete(at, count));
    return `delete ${count} at ${at} in ${id}`;
  }
  const inserted = randomText(rng, 8);
  doc.transact(() => {
    text.delete(at, count);
    text.insert(at, inserted);
  });
  return `replace ${count} at ${at} in ${id}`;
}

// --- The run -------------------------------------------------------------

export interface FuzzOptions {
  seed: number;
  /** Local edits across all clients. */
  ops: number;
  editors: Member[];
  viewers: Member[];
  /** Share of store calls that fail on purpose while edits are running. */
  failureRate: number;
  /** Mid-run checks of every connected replica against the server. */
  checkpoints: number;
  pool: pg.Pool;
  notebookId: string;
}

export interface FuzzStats {
  edits: number;
  viewerEdits: number;
  delivered: number;
  drops: number;
  connects: number;
  roomLoads: number;
  compactions: number;
  appends: number;
  injectedFailures: number;
  unloads: number;
  /** Times someone came back while the room was unloading (it must stay). */
  returnsDuringUnload: number;
  crashes: number;
  restarts: number;
  serverEvents: number;
  /** Replicas compared against the server at mid-run checkpoints. */
  checkpointComparisons: number;
  /** Server changes lost in the crash that a viewer still holds (a known limit). */
  viewerKeptLostServerChanges: number;
}

/** As good as never, for a timer (the largest delay setTimeout takes). */
const NEVER_MS = 2 ** 31 - 1;

/**
 * Short timings so batching and compaction happen all the time. Unloading
 * only happens when the run asks for it (see everyoneLeaves): when an empty
 * room unloads otherwise depends on real time, and a reconnect then finds
 * the room loaded or not, which changes what the clients receive. Stale
 * presence isn't swept, for the same reason (the sweep sends messages on a
 * timer). Each run gets its own copy, which it adjusts at a crash.
 */
function fuzzTimings(): ManagerTimings {
  return {
    ...DEFAULT_MANAGER_TIMINGS,
    flushIntervalMs: 2,
    flushBytes: 2048,
    compactAfterRows: 4,
    retryBaseMs: 2,
    retryMaxMs: 20,
    unloadGraceMs: NEVER_MS,
    unloadRetryMs: 5,
    awarenessSweepMs: NEVER_MS,
  };
}

/**
 * Edits made between the start of the crash window and the crash. At the
 * window's start everything is written and writing stops, so the crash loses
 * exactly the changes made in the window, whatever the timing.
 */
const CRASH_WINDOW_EDITS = 40;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Server log events that mean something went wrong on the server or in a message. */
const BAD_EVENTS = new Set(["conn.handle_failed", "conn.malformed", "room.failed"]);
/** Close codes a client may see in this simulation (restarts, injected failures). */
const EXPECTED_CLOSE_CODES = new Set([1011, 1012]);

/** FNV-1a over the schedule's actions: equal fingerprints mean the same schedule ran. */
function fnv(hash: number, text: string): number {
  let h = hash;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export class FuzzRun {
  readonly stats: FuzzStats = {
    edits: 0,
    viewerEdits: 0,
    delivered: 0,
    drops: 0,
    connects: 0,
    roomLoads: 0,
    compactions: 0,
    appends: 0,
    injectedFailures: 0,
    unloads: 0,
    returnsDuringUnload: 0,
    crashes: 0,
    restarts: 0,
    serverEvents: 0,
    checkpointComparisons: 0,
    viewerKeptLostServerChanges: 0,
  };
  /** Everything that went wrong, checked at the end (with the state comparison). */
  readonly problems: string[] = [];
  /** The last actions, printed when a run fails. */
  readonly trace: string[] = [];
  /** Every action, in order (written out with FUZZ_TRACE_DIR, to compare two runs). */
  readonly schedule: string[] = [];
  /**
   * The Yjs client IDs of rooms that crashed: the server's own changes (run
   * and AI state) carry them. See viewerProblems.
   */
  readonly crashedServerClients = new Set<number>();

  // One generator per concern, so a draw skipped or added in one (a
  // delivery that found nothing to deliver) doesn't shift the others.
  private readonly actionRng: Rng;
  private readonly netRng: Rng;
  private readonly editRng: Rng;
  private readonly eventRng: Rng;
  private readonly store: FlakyStore;
  private readonly timings = fuzzTimings();
  private manager: RoomManager;
  private readonly clients: SimClient[] = [];
  private readonly options: FuzzOptions;
  private step = 0;
  private fingerprint_ = 0x811c9dc5;
  private nextClientId = 1000;
  private nextServerClientId = 900_000;
  private restoreLog: (() => void) | null = null;

  constructor(options: FuzzOptions) {
    this.options = options;
    const { seed } = options;
    this.actionRng = new Rng(seed);
    this.netRng = new Rng(seed ^ 0x6e6574);
    this.editRng = new Rng(seed ^ 0x656469);
    this.eventRng = new Rng(seed ^ 0x657674);
    this.store = new FlakyStore(options.pool, seed, options.failureRate);
    this.manager = this.newManager();
    for (const [i, member] of options.editors.entries()) this.addClient(`editor${i}`, member);
    for (const [i, member] of options.viewers.entries()) this.addClient(`viewer${i}`, member);
  }

  /**
   * A RoomManager whose rooms get fixed Yjs client IDs instead of random
   * ones. The ID decides more than bytes: a reloaded document lists its
   * changes by client ID, which sets the order the room sees the cells in,
   * and so which cell the AI's presence points at. Each room gets a new ID
   * (two rooms writing as one client would corrupt the document). A new
   * room is registered before it has loaded anything or written, so
   * setting the ID then is safe.
   */
  private newManager(): RoomManager {
    const manager = new RoomManager(this.store, this.timings);
    const rooms = manager.rooms;
    const set = rooms.set.bind(rooms);
    const named = new WeakSet<Room>();
    rooms.set = (id: string, room: Room) => {
      if (!named.has(room)) {
        named.add(room);
        room.doc.clientID = this.nextServerClientId++;
      }
      return set(id, room);
    };
    return manager;
  }

  /** A hash of every action the run took, in order (see fnv). */
  get fingerprint(): string {
    return this.fingerprint_.toString(16).padStart(8, "0");
  }

  private addClient(label: string, member: Member): SimClient {
    const client = new SimClient(label, member, this.nextClientId++, this.problems);
    this.clients.push(client);
    return client;
  }

  private note(action: string): void {
    const line = `#${this.step} ${action}`;
    this.fingerprint_ = fnv(this.fingerprint_, `${line}\n`);
    this.schedule.push(line);
    this.trace.push(line);
    if (this.trace.length > 60) this.trace.shift();
  }

  private room(): Room | undefined {
    return this.manager.rooms.get(this.options.notebookId);
  }

  /** Records server errors (a message it couldn't handle, a failed room) as problems. */
  private watchLog(): void {
    const { warn, error } = log;
    // Failures the FlakyStore caused on purpose.
    const injected = (fields?: Record<string, unknown>) =>
      String(fields?.error ?? "").startsWith("injected ");
    const record = (event: string, fields?: Record<string, unknown>) => {
      if (BAD_EVENTS.has(event) && !injected(fields)) {
        this.problems.push(`server logged ${event} ${JSON.stringify(fields ?? {})}`);
      }
    };
    log.warn = (event, fields) => {
      record(event, fields);
      warn(event, fields);
    };
    log.error = (event, fields) => {
      record(event, fields);
      if (!injected(fields)) error(event, fields);
    };
    this.restoreLog = () => {
      log.warn = warn;
      log.error = error;
    };
  }

  async run(): Promise<void> {
    this.watchLog();
    try {
      for (const client of this.clients) await this.connect(client);
      const { ops, checkpoints } = this.options;
      // Each run has one of each whole-room event, somewhere in the middle,
      // and its checkpoints spread over the run. Keyed by the edit count at
      // which they happen.
      const milestones = new Map<number, () => Promise<void>>();
      const at = (fraction: number, action: () => Promise<void>) => {
        let edit = Math.max(1, Math.floor(ops * fraction));
        while (milestones.has(edit)) edit++;
        milestones.set(edit, action);
      };
      const crashAt = 0.45 + this.actionRng.next() * 0.15;
      at(0.08 + this.actionRng.next() * 0.08, () => this.returnDuringUnload());
      at(0.2 + this.actionRng.next() * 0.15, () => this.everyoneLeaves());
      at(crashAt, () => this.crash());
      at(crashAt - CRASH_WINDOW_EDITS / ops, () => this.startCrashWindow());
      at(0.7 + this.actionRng.next() * 0.15, () => this.restart());
      for (let i = 0; i < checkpoints; i++) {
        at((i + 0.3 + this.actionRng.next() * 0.4) / checkpoints, () => this.checkpoint());
      }
      while (this.stats.edits < ops) {
        this.step++;
        const before = this.stats.edits;
        await this.randomAction();
        if (this.stats.edits !== before) {
          const milestone = milestones.get(this.stats.edits);
          if (milestone) {
            milestones.delete(this.stats.edits);
            await milestone();
          }
        }
      }
      await this.quiesce();
    } finally {
      this.restoreLog?.();
    }
  }

  /**
   * One step. Every draw is made from fixed lists (all clients, both
   * directions), never from "who is online now" or "which queues have
   * something": a choice that finds nothing to do is skipped. So the
   * sequence of draws doesn't depend on anything timing could change.
   */
  private async randomAction(): Promise<void> {
    const roll = this.actionRng.next();
    // Weights: mostly edits and deliveries, so most changes travel live and
    // many concurrent ones cross on the way; drops are rarer, so offline
    // stretches are long enough to pile up offline edits.
    if (roll < 0.2) {
      const client = this.editRng.pick(this.clients);
      // Viewers edit too, less often: the server must drop every one.
      const viewerEdits = this.editRng.chance(0.3);
      if (client.isViewer && !viewerEdits) return;
      const what = randomEdit(this.editRng, client);
      this.stats.edits++;
      if (client.isViewer) this.stats.viewerEdits++;
      this.note(`${client.label}${client.link ? "" : " (offline)"}: ${what}`);
    } else if (roll < 0.77) {
      // One message, or (a third of the time) a burst: a socket catching up
      // on a backlog. If the drawn direction has nothing, the other one
      // moves instead (no new draw, so the sequence stays fixed).
      const client = this.netRng.pick(this.clients);
      const direction = this.netRng.chance(0.5) ? "up" : "down";
      const count = this.netRng.chance(1 / 3) ? 1 + this.netRng.int(20) : 1;
      if (this.deliverFrom(client, direction, count) === 0) {
        this.deliverFrom(client, direction === "up" ? "down" : "up", count);
      }
    } else if (roll < 0.78) {
      const client = this.netRng.pick(this.clients);
      const partial = this.netRng.next();
      if (client.link) this.drop(client, partial);
    } else if (roll < 0.81) {
      const client = this.netRng.pick(this.clients);
      if (!client.link) await this.connect(client);
    } else if (roll < 0.825) {
      await this.serverEvent();
    } else if (roll < 0.845) {
      const client = this.editRng.pick(this.clients);
      const where = this.editRng.next();
      const ids = cellIds(client.doc).filter((id) => textOf(client.doc, id));
      if (ids.length > 0) {
        const text = textOf(client.doc, ids[Math.floor(where * ids.length)]!)!;
        client.moveCursor(text, Math.floor(where * (text.length + 1)));
        this.note(`${client.label}: cursor`);
      }
    } else if (roll < 0.855) {
      const client = this.netRng.pick(this.clients);
      const steps = 5 + this.netRng.int(60);
      if (client.link) {
        client.link.stalledUntil = this.step + steps;
        this.note(`${client.label}: connection stalls`);
      }
    } else if (roll < 0.95) {
      await tick();
    } else {
      // Real time passes: batches are written and compacted.
      await sleep(this.actionRng.int(4));
    }
  }

  // --- Network ---------------------------------------------------------

  /**
   * Moves up to `count` messages one way on the client's socket (a close
   * from the server counts as the last message toward the client). Nothing
   * happens if the client is offline, its socket is stalled or that queue is
   * empty.
   */
  private deliverFrom(
    client: SimClient,
    direction: "up" | "down",
    count: number,
    ignoreStalls = false,
  ): number {
    let moved = 0;
    for (; moved < count; moved++) {
      const link = client.link;
      if (!link || (!ignoreStalls && link.stalledUntil > this.step)) break;
      if (direction === "up") {
        const data = link.toServer.shift();
        if (!data) break;
        if (link.ws.readyState === OPEN) link.ws.emit("message", Buffer.from(data), true);
      } else if (link.toClient.length > 0) {
        client.receive(link.toClient.shift()!);
      } else if (link.closeCode !== null) {
        this.serverClosed(link);
      } else {
        break;
      }
      this.stats.delivered++;
    }
    return moved;
  }

  /** Delivers every queued message, in a fixed order, until nothing is left. */
  private drainAll(): void {
    let moved = true;
    while (moved) {
      moved = false;
      for (const client of this.clients) {
        if (this.deliverFrom(client, "up", Infinity, true) > 0) moved = true;
        if (this.deliverFrom(client, "down", Infinity, true) > 0) moved = true;
      }
    }
  }

  /** The client learns the server closed its socket. */
  private serverClosed(link: Link): void {
    const code = link.closeCode!;
    const client = link.client;
    client.link = null;
    client.synced = false;
    this.note(`${client.label}: closed by the server (${code})`);
    if (!EXPECTED_CLOSE_CODES.has(code)) {
      this.problems.push(`${client.label} was closed with unexpected code ${code}`);
    }
  }

  /**
   * Waits until the server has finished what it started on its own: loading
   * or unloading the room, events still reading Postgres, reconciliation
   * after a load, and the unload of a room loaded only for an event (it's
   * scheduled with a zero-delay timer). Its effects on the document then
   * land at the same point of the schedule on every run.
   */
  private async settle(): Promise<void> {
    const busy = () => {
      const room = this.room();
      return room && (room.holds > 0 || room.unloading || room.status === "loading");
    };
    let calm = 0;
    for (let i = 0; i < 5_000; i++) {
      await tick();
      if (busy()) {
        calm = 0;
        await sleep(1);
        continue;
      }
      if (++calm < 3) continue;
      // A timer the server set before this one (a zero-delay unload) fires
      // first, and its first steps run before this resumes.
      await sleep(1);
      if (!busy()) return;
      calm = 0;
    }
  }

  /** A new connection, waiting until the server has opened (or refused) it. */
  private async connect(client: SimClient): Promise<void> {
    // The connection opens only once its membership check returns, and that
    // check is held until the room has loaded and the server has finished
    // reconciling it (which can write to the document). Otherwise those
    // writes reach the client inside its first sync or as separate messages
    // after it, depending on timing.
    let release!: () => void;
    this.store.memberRoleGate = new Promise((resolve) => (release = resolve));
    let link: Link;
    try {
      link = this.openLink(client);
      await this.settle();
    } finally {
      this.store.memberRoleGate = null;
      release();
    }
    // Wait for the server's verdict, so the scheduler continues from the
    // same point however long Postgres took.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (link.ws.readyState !== OPEN) break;
      const conn = this.connectionOf(link);
      if (conn && conn.state !== "pending") break;
      await sleep(1);
    }
    if (link.ws.readyState === OPEN && this.connectionOf(link)?.state === "pending") {
      this.problems.push(`${client.label}'s connection never opened`);
    }
    await this.settle();
  }

  /** Starts a connection: the client speaks first (step 1 and presence), as y-websocket does. */
  private openLink(client: SimClient): Link {
    const early = this.netRng.chance(0.5);
    const link = new Link(client);
    client.link = link;
    client.synced = false;
    this.stats.connects++;
    this.note(`${client.label}: connects`);
    this.manager.connect(link.ws as unknown as WebSocket, {
      userId: client.member.userId,
      name: client.member.name,
      notebookId: this.options.notebookId,
      role: client.member.role,
    });
    link.toServer.push(syncFrame((e) => syncProtocol.writeSyncStep1(e, client.doc)));
    link.toServer.push(awarenessFrame(client.awareness));
    // Sometimes everything arrives while the room is still loading and the
    // membership check is running, so it waits in the connection's queue.
    if (early) {
      while (link.toServer.length > 0) {
        link.ws.emit("message", Buffer.from(link.toServer.shift()!), true);
      }
    }
    return link;
  }

  /**
   * Makes sure someone is connected, so the room is loaded and the next
   * disconnects schedule its unload (an empty room's unload timer was set
   * when it emptied, with the grace period in force then).
   */
  private async someoneConnected(): Promise<void> {
    if (this.clients.some((c) => c.link)) return;
    await this.connect(this.clients.find((c) => !c.isViewer)!);
  }

  private connectionOf(link: Link): Connection | undefined {
    const room = this.room();
    return room ? [...room.conns].find((c) => (c.ws as unknown) === link.ws) : undefined;
  }

  /**
   * The network drops: part of what was in flight still arrives (`partial`,
   * 0 to 1, says how much of each queue), the rest is lost. The client keeps
   * editing offline.
   */
  private drop(client: SimClient, partial: number): void {
    const link = client.link!;
    // Recorded, so two runs of a seed that differ in what was in flight
    // differ in their fingerprints right here.
    const inFlight = `${link.toServer.length} up, ${link.toClient.length} down in flight`;
    for (let n = Math.floor(partial * (link.toServer.length + 1)); n > 0; n--) {
      const data = link.toServer.shift()!;
      if (link.ws.readyState === OPEN) link.ws.emit("message", Buffer.from(data), true);
    }
    for (let n = Math.floor(partial * (link.toClient.length + 1)); n > 0; n--) {
      client.receive(link.toClient.shift()!);
    }
    link.broken = true;
    link.toServer.length = 0;
    link.toClient.length = 0;
    client.link = null;
    client.synced = false;
    this.stats.drops++;
    this.note(`${client.label}: connection drops (${inFlight})`);
    link.ws.finish(1006);
  }

  // --- Whole-room events ----------------------------------------------

  /**
   * Everyone leaves, and someone comes back while the room is unloading
   * (after its final write, during its compaction). The room must notice it
   * isn't empty anymore and stay, with the same document: that path is
   * timing-dependent in real life, so the compaction is held here until the
   * client has connected. Failures are off meanwhile, so it always gets there.
   */
  private async returnDuringUnload(): Promise<void> {
    this.note("everyone leaves, then someone returns during the unload");
    await this.someoneConnected();
    const before = this.room();
    let release!: () => void;
    this.store.compactGate = new Promise((resolve) => (release = resolve));
    this.store.enabled = false;
    this.timings.unloadGraceMs = 0;
    try {
      for (const client of this.clients) if (client.link) this.drop(client, 0.5);
      const deadline = Date.now() + 10_000;
      while (before && !before.unloading && Date.now() < deadline) await sleep(1);
      if (!before?.unloading) {
        this.problems.push("the room never started unloading");
        return;
      }
      this.timings.unloadGraceMs = NEVER_MS;
      const editors = this.clients.filter((c) => !c.isViewer);
      const returning = editors[this.netRng.int(editors.length)]!;
      // Not connect(): it settles, which would wait for the held unload.
      this.openLink(returning);
      while (Date.now() < deadline && this.room() === before && before.unloading) {
        const link = returning.link;
        if (!link || link.ws.readyState !== OPEN || this.connectionOf(link)?.state === "open") {
          break;
        }
        await sleep(1);
      }
    } finally {
      this.timings.unloadGraceMs = NEVER_MS;
      this.store.compactGate = null;
      release();
      this.store.enabled = true;
    }
    await this.settle();
    if (this.room() !== before || before?.status !== "ready") {
      this.problems.push("the room unloaded although someone came back during the unload");
    } else {
      this.stats.returnsDuringUnload++;
    }
  }

  /** Everyone disconnects: the room is saved, compacted and unloaded, then reloaded later. */
  private async everyoneLeaves(): Promise<void> {
    this.note("everyone leaves");
    await this.someoneConnected();
    this.timings.unloadGraceMs = 0;
    try {
      for (const client of this.clients) if (client.link) this.drop(client, 0.5);
      const deadline = Date.now() + 10_000;
      while (this.room() && Date.now() < deadline) await sleep(2);
    } finally {
      this.timings.unloadGraceMs = NEVER_MS;
    }
    if (this.room()) this.problems.push("the room didn't unload after everyone left");
    else this.stats.unloads++;
  }

  /**
   * Before the crash: everything so far is written, then nothing more is,
   * so the crash loses exactly what changes from here on. Injected failures
   * are off until after the crash, so this write can't fail.
   */
  private async startCrashWindow(): Promise<void> {
    this.note("crash window starts");
    this.store.enabled = false;
    const room = this.room();
    for (let attempt = 0; room && room.hasUnsaved && attempt < 50; attempt++) {
      await room.flushAll().catch(() => sleep(5));
    }
    if (room?.hasUnsaved) this.problems.push("couldn't write everything before the crash");
    this.timings.flushIntervalMs = NEVER_MS;
    this.timings.flushBytes = Infinity;
  }

  /**
   * The server process dies: whatever the room hadn't written yet is lost.
   * Editors that hold those changes send them again when they reconnect.
   */
  private async crash(): Promise<void> {
    this.note("server crashes");
    const old = this.manager;
    for (const room of old.rooms.values()) {
      this.crashedServerClients.add(room.doc.clientID);
      if (room.unloadTimer) clearTimeout(room.unloadTimer);
      room.destroy();
    }
    old.rooms.clear();
    for (const client of this.clients) if (client.link) this.drop(client, 0);
    await old.shutdown();
    const fresh = fuzzTimings();
    this.timings.flushIntervalMs = fresh.flushIntervalMs;
    this.timings.flushBytes = fresh.flushBytes;
    this.store.enabled = true;
    this.manager = this.newManager();
    this.stats.crashes++;
  }

  /**
   * A clean restart: sockets closed with 1012, everything saved, a new
   * manager. Failures are off meanwhile, so the save always succeeds.
   */
  private async restart(): Promise<void> {
    this.note("server restarts");
    this.store.enabled = false;
    await this.manager.shutdown();
    this.store.enabled = true;
    this.manager = this.newManager();
    this.stats.restarts++;
  }

  /** An event from the API (a run or an AI request), on a cell some replica has. */
  private async serverEvent(): Promise<void> {
    const notebookId = this.options.notebookId;
    const rng = this.eventRng;
    const doc = rng.pick(this.clients).doc;
    const sqlCells = cellIds(doc).filter((id) => cellMap(doc, id)?.get("type") === "sql");
    const gone = rng.chance(0.1);
    const pickCell = rng.next();
    const cellId =
      sqlCells.length > 0 && !gone ? sqlCells[Math.floor(pickCell * sqlCells.length)]! : "gone";
    const executionId = rng.hex(16);
    const kind = rng.int(4);
    const runId = rng.chance(0.7) ? rng.uuid() : null;
    const requestId = rng.uuid();
    this.stats.serverEvents++;
    if (kind === 0) {
      this.note(`server: run_started on ${cellId}`);
      this.manager.handleEvent({
        type: "run_started",
        notebookId,
        cellId,
        executionId,
        userName: "Runner",
        startedAt: new Date(0).toISOString(),
        expiresAt: null,
      });
    } else if (kind === 1) {
      this.note(`server: run_finished on ${cellId}`);
      this.manager.handleEvent({ type: "run_finished", notebookId, cellId, executionId, runId });
    } else if (kind === 2) {
      this.note(`server: ai_started on ${cellId}`);
      this.manager.handleEvent({
        type: "ai_started",
        notebookId,
        cellId,
        requestId,
        kind: "generate",
        userName: "Asker",
      });
    } else {
      this.note(`server: ai_failed on ${cellId}`);
      this.manager.handleEvent({
        type: "ai_failed",
        notebookId,
        cellId,
        requestId,
        message: "no",
      });
    }
    await this.settle();
  }

  // --- Checking --------------------------------------------------------

  /**
   * A mid-run check, without reconnecting anyone: every queued message is
   * delivered, then every client still connected must match the server
   * (viewers by the viewer rule). The end-of-run check reconnects everyone
   * first, and a reconnect's handshake repairs a missed relay, so a server
   * that loses messages could otherwise pass.
   */
  private async checkpoint(): Promise<void> {
    this.note("checkpoint");
    for (let round = 0; round < 50; round++) {
      this.drainAll();
      await this.settle();
      if (
        this.clients.every(
          (c) => !c.link || (c.link.toServer.length === 0 && c.link.toClient.length === 0),
        )
      ) {
        break;
      }
    }
    const room = this.room();
    if (!room || room.status !== "ready") return;
    const server = Y.snapshot(room.doc);
    // After the crash, the server lacks whatever it lost of editors that
    // haven't reconnected yet; a viewer that saw those changes before the
    // crash is ahead of it on them until they do (the final check, after
    // everyone reconnected, allows no such thing).
    const notBackYet = new Set(
      this.stats.crashes > 0
        ? this.clients.filter((c) => !c.isViewer && !c.link).map((c) => c.doc.clientID)
        : [],
    );
    for (const client of this.clients) {
      const link = client.link;
      if (!link || !client.synced || this.connectionOf(link)?.state !== "open") continue;
      this.stats.checkpointComparisons++;
      const where = `at checkpoint (edit ${this.stats.edits})`;
      if (client.isViewer) {
        const found = viewerProblems(room.doc, client, this.crashedServerClients, notBackYet);
        for (const problem of found.problems) this.problems.push(`${problem} ${where}`);
      } else if (!Y.equalSnapshots(server, Y.snapshot(client.doc))) {
        this.problems.push(
          `${client.label} differs from the server ${where} ` +
            firstDifference(docJson(client.doc), docJson(room.doc)),
        );
      }
    }
  }

  private quiet(): boolean {
    const room = this.room();
    if (!room || room.status !== "ready" || room.holds > 0) return false;
    return this.clients.every((client) => {
      const link = client.link;
      if (!link || link.toServer.length > 0 || link.toClient.length > 0) return false;
      if (link.closeCode !== null) return false;
      const conn = this.connectionOf(link);
      return conn?.state === "open" && client.synced;
    });
  }

  /**
   * Stops the edits, turns failures off, reconnects everyone and delivers
   * every message, until nothing moves for a few rounds.
   */
  private async quiesce(): Promise<void> {
    this.note("quiesce");
    this.store.enabled = false;
    let quietRounds = 0;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      for (const client of this.clients) if (!client.link) await this.connect(client);
      this.drainAll();
      await this.settle();
      if (this.quiet()) {
        if (++quietRounds >= 3) return;
      } else {
        quietRounds = 0;
      }
    }
    this.problems.push("the clients and the server never settled");
  }

  /** Writes everything the room holds, so Postgres has the latest document. */
  async flushRoom(): Promise<void> {
    const room = this.room();
    if (!room) throw new Error("the room isn't loaded after quiescing");
    for (let attempt = 0; attempt < 20 && room.hasUnsaved; attempt++) {
      await room.flushAll().catch(() => sleep(10));
    }
    if (room.hasUnsaved) throw new Error("the room could not save its changes");
  }

  /** The server's in-memory document. */
  serverDoc(): Y.Doc {
    const room = this.room();
    if (!room) throw new Error("the room isn't loaded");
    return room.doc;
  }

  editorDocs(): { label: string; doc: Y.Doc }[] {
    return this.clients.filter((c) => !c.isViewer).map((c) => ({ label: c.label, doc: c.doc }));
  }

  viewerClients(): SimClient[] {
    return this.clients.filter((c) => c.isViewer);
  }

  /** A viewer's page reload: a new, empty replica that syncs from the server. */
  async freshViewerDoc(member: Member): Promise<Y.Doc> {
    const client = this.addClient("viewer-reload", member);
    await this.connect(client);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !client.synced) {
      this.drainAll();
      await sleep(2);
    }
    if (!client.synced) throw new Error("a fresh viewer never synced");
    return client.doc;
  }

  /** The document as Postgres has it, loaded the way a room loads it. */
  async storedDoc(): Promise<Y.Doc> {
    const loaded = await new Store(this.options.pool).load(this.options.notebookId);
    const doc = new Y.Doc();
    if (loaded?.state) Y.applyUpdate(doc, loaded.state);
    return doc;
  }

  collectStats(): FuzzStats {
    this.stats.roomLoads = this.store.loads;
    this.stats.compactions = this.store.compactions;
    this.stats.appends = this.store.appends;
    this.stats.injectedFailures = this.store.injected;
    return this.stats;
  }

  async close(): Promise<void> {
    await this.manager.shutdown();
    for (const client of this.clients) client.destroy();
  }
}

/** What a replica has deleted (Yjs exports the type only through Snapshot). */
type DeleteSet = Y.Snapshot["ds"];

/** A delete set as sorted, merged [clock, length] ranges per client. */
function normalizedDeletes(ds: DeleteSet): Map<number, [number, number][]> {
  const out = new Map<number, [number, number][]>();
  for (const [client, ranges] of ds.clients) {
    const sorted = ranges.map((r) => [r.clock, r.len] as [number, number]);
    sorted.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [clock, len] of sorted) {
      const last = merged[merged.length - 1];
      if (last && last[0] + last[1] >= clock) last[1] = Math.max(last[1], clock + len - last[0]);
      else merged.push([clock, len]);
    }
    out.set(client, merged);
  }
  return out;
}

/** Deleted items in `small` that `big` doesn't have deleted (a count). */
function deletesMissing(big: DeleteSet, small: DeleteSet): number {
  const have = normalizedDeletes(big);
  let missing = 0;
  for (const [client, ranges] of normalizedDeletes(small)) {
    const covering = have.get(client) ?? [];
    for (const [clock, len] of ranges) {
      // `covering` is merged, so its overlaps with this range don't overlap.
      let covered = 0;
      for (const [from, n] of covering) {
        const overlap = Math.min(from + n, clock + len) - Math.max(from, clock);
        if (overlap > 0) covered += overlap;
      }
      missing += len - covered;
    }
  }
  return missing;
}

/**
 * How a viewer's replica may differ from the server's: only by having more
 * (its own edits, which the server drops, and the one known limit below).
 * It must have every change and every deletion the server has. A state
 * vector alone can't show that: deleting doesn't advance it.
 *
 * Known limit, counted rather than failed: the viewer may be ahead of the
 * server on a crashed room's own client ID, holding a change the server made
 * itself (run or AI state) that reached the viewer and was lost in the crash
 * before it was written. An editor would send it back on reconnecting; a
 * viewer can't (see the test in rooms.test.ts that pins it).
 *
 * `mayBeAhead`: other client IDs the viewer may be ahead on, not counted
 * (see FuzzRun.checkpoint).
 */
export function viewerProblems(
  server: Y.Doc,
  viewer: SimClient,
  crashedServerClients: ReadonlySet<number>,
  mayBeAhead: ReadonlySet<number> = new Set(),
): { problems: string[]; knownLimit: number } {
  const problems: string[] = [];
  let knownLimit = 0;
  const serverVector = stateVector(server);
  const vector = stateVector(viewer.doc);
  for (const [client, clock] of vector) {
    if (client === viewer.doc.clientID) continue;
    const serverClock = serverVector.get(client) ?? 0;
    if (clock === serverClock) continue;
    if (clock > serverClock && crashedServerClients.has(client)) {
      knownLimit++;
      continue;
    }
    if (clock > serverClock && mayBeAhead.has(client)) continue;
    problems.push(
      `${viewer.label} has client ${client}'s changes up to clock ${clock}, ` +
        `the server up to ${serverClock}`,
    );
  }
  for (const [client, clock] of serverVector) {
    if (!vector.has(client)) {
      problems.push(`${viewer.label} is missing client ${client}'s changes (up to ${clock})`);
    }
  }
  const missing = deletesMissing(Y.snapshot(viewer.doc).ds, Y.snapshot(server).ds);
  if (missing > 0) {
    problems.push(`${viewer.label} is missing ${missing} deletions the server has`);
  }
  return { problems, knownLimit };
}

// --- Comparing replicas ----------------------------------------------------

/** The document's content as JSON, for a readable diff when bytes differ. */
export function docJson(doc: Y.Doc): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
    }
    return value;
  };
  return JSON.stringify(sortKeys(doc.getMap("cells").toJSON()), null, 1);
}

/** Where two strings first differ, with some context, for failure messages. */
export function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return "(identical JSON: the difference is in metadata)";
  const from = Math.max(0, i - 80);
  return `at ${i}:\n  ${JSON.stringify(a.slice(from, i + 80))}\n  ${JSON.stringify(b.slice(from, i + 80))}`;
}

export function stateVector(doc: Y.Doc): Map<number, number> {
  return Y.decodeStateVector(Y.encodeStateVector(doc));
}

/**
 * The document's state in a form that's the same for the same content.
 *
 * Y.encodeStateAsUpdate writes the replica's structs as they happen to be
 * cut up, and replicas cut the same content differently: a deleted range
 * that one replica garbage-collected in one transaction is several pieces in
 * another that received it in several. Loading the state into a fresh
 * document and encoding that merges every piece that can be merged, so equal
 * content gives equal bytes. The state vector (which changes each replica
 * has) and the delete set (what's deleted) are compared directly as well
 * (see replicaDigest), so this can't hide a real difference.
 */
export function canonicalState(doc: Y.Doc): Uint8Array {
  const fresh = new Y.Doc();
  try {
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
    return Y.encodeStateAsUpdate(fresh);
  } finally {
    fresh.destroy();
  }
}

/** What a replica holds, compared piece by piece so a mismatch says which piece. */
export interface ReplicaDigest {
  /** Every change each client made that this replica has (encoded state vector). */
  stateVector: string;
  /** What's deleted, normalized (merged ranges, sorted). */
  deleteSet: string;
  /** canonicalState, hex. */
  state: string;
}

export function replicaDigest(doc: Y.Doc): ReplicaDigest {
  const { ds } = Y.decodeUpdate(Y.encodeStateAsUpdate(doc));
  const deletes = [...ds.clients.entries()]
    .sort(([a], [b]) => a - b)
    .map(([client, ranges]) => {
      const sorted = ranges.map((r) => [r.clock, r.len] as const).sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const [clock, len] of sorted) {
        const last = merged[merged.length - 1];
        if (last && last[0] + last[1] >= clock) last[1] = Math.max(last[1], clock + len - last[0]);
        else merged.push([clock, len]);
      }
      return [client, merged];
    });
  return {
    stateVector: Buffer.from(Y.encodeStateVector(doc)).toString("hex"),
    deleteSet: JSON.stringify(deletes),
    state: Buffer.from(canonicalState(doc)).toString("hex"),
  };
}
