/**
 * Awareness (presence and cursors) for one room, with server-enforced identity.
 *
 * Awareness is the y-protocols side channel for ephemeral state: who is here,
 * where their cursor is. It isn't part of the document and is never stored.
 * Each browser tab has an awareness clientID (a random uint32) and a state
 * object, and announces changes with a clock that it increments each time.
 *
 * Wire format of an awareness update (decoded and re-encoded here rather
 * than trusting clients' bytes):
 *   varUint count, then per entry:
 *     varUint clientID, varUint clock, varString JSON state ("null" = left)
 * A receiver applies an entry only if its clock is newer than the one it has
 * for that clientID (or equal, for a removal).
 *
 * What the server enforces:
 * - Ownership. The first clientID a connection announces becomes its own,
 *   and it can't announce any other. A y-websocket client has exactly one
 *   awareness clientID and announces it first, as soon as the socket opens.
 *   Clients also re-send states they receive from others (the provider
 *   re-broadcasts every awareness change it sees), so allowing more than one
 *   would let a client claim a peer's ID by accident the moment that peer
 *   disconnected, and that peer's reconnect would then be ignored.
 *   One exception: the same user may take over a clientID with the first
 *   announcement of a new connection. That's a tab reconnecting after a
 *   network drop while the server still holds its old, dead socket (found
 *   only by the next ping); without it, that person's presence would be
 *   missing until the old socket timed out. Another user can never take an
 *   ID over, so this can't be used to appear as someone else.
 * - Identity. `state.user` is replaced with { id, name, color } from the
 *   connection's ticket, so nobody can appear as someone else.
 * - Size. States over MAX_STATE_BYTES are dropped.
 *
 * Clocks: the server relays states with its own clock, not the client's. A
 * client that reconnects keeps its old clock, which peers have already seen,
 * so relaying the client's clock would make peers ignore it until its next
 * periodic renewal (up to 15 s later). The server's clock is one counter per
 * room that never goes backwards and starts from the current time in
 * milliseconds, so it stays ahead of anything a previous server process sent.
 * The same problem runs the other way: a client that reconnects forgets its
 * peers' states on disconnect but keeps their clocks, so the full presence
 * list it gets on joining (or on asking) carries a fresh clock for every
 * entry, or it would ignore idle peers until they next renew. One catch: an
 * entry still held by the same user's old socket may be the joining tab's
 * own, and a fresh clock would make the tab overwrite its local state with
 * that stale copy. So until a connection has announced its own clientID, its
 * user's entries on other connections are held back, and sent (fresh clocks,
 * minus the one it just took over) right after it announces.
 * The owner itself gets its own entries echoed back with its own clock: it
 * ignores them (same clock), but receiving them keeps its connection alive
 * (y-websocket's client reconnects after 30 s without any message).
 */
import { createHash } from "node:crypto";

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

import { MalformedMessage } from "./protocol.ts";

/** Per-state cap. Real states (a name, a color, two cursor positions) are a few hundred bytes. */
export const MAX_STATE_BYTES = 8 * 1024;
/** Same as y-protocols: clients renew every 15 s and drop peers silent for 30 s. */
export const OUTDATED_TIMEOUT_MS = 30_000;
// Bounds the work one message can cause. A client re-sending every state it
// knows sends one entry per collaborator.
const MAX_ENTRIES_PER_MESSAGE = 10_000;
const MAX_CLIENT_ID = 0xffffffff;

/**
 * Cursor colors. Picked by hashing the user ID, so a person has the same
 * color in every viewer's browser. Two people can share a color; the name
 * label next to the cursor tells them apart.
 */
export const PALETTE = [
  "#e6194b",
  "#3cb44b",
  "#4363d8",
  "#f58231",
  "#911eb4",
  "#0f9b8e",
  "#f032e6",
  "#9a6324",
  "#808000",
  "#000075",
] as const;

export function colorFor(userId: string): string {
  const hash = createHash("sha256").update(userId).digest();
  return PALETTE[hash.readUInt32BE(0) % PALETTE.length]!;
}

export interface AwarenessUser {
  id: string;
  name: string;
  color: string;
}

type State = Record<string, unknown>;

interface Client<O> {
  owner: O;
  /** The owner's user ID (from its ticket). */
  userId: string;
  /** The last clock the owner sent. */
  clientClock: number;
  /** The clock peers last received from the server. */
  clock: number;
  /** null after the owner removed it or it timed out. */
  state: State | null;
  lastUpdated: number;
}

/** Awareness payloads to send after a change. Either may be null (nothing to send). */
export interface AwarenessBroadcast {
  /** For the connection that sent the change. */
  forOwner: Uint8Array | null;
  /** For everyone else in the room. */
  forPeers: Uint8Array | null;
}

interface Entry {
  clientId: number;
  clock: number;
  state: State | null;
}

function encodeEntries(entries: Entry[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const { clientId, clock, state } of entries) {
    encoding.writeVarUint(encoder, clientId);
    encoding.writeVarUint(encoder, clock);
    encoding.writeVarString(encoder, JSON.stringify(state));
  }
  return encoding.toUint8Array(encoder);
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function parseState(bytes: Uint8Array): State | null {
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(bytes));
  } catch {
    throw new MalformedMessage("awareness state is not JSON");
  }
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new MalformedMessage("awareness state is not an object");
  }
  return value as State;
}

export class RoomAwareness<O> {
  private readonly clients = new Map<number, Client<O>>();
  /** The clientID each connection claimed (it may since have been taken over). */
  private readonly ownedBy = new Map<O, number>();
  /** Connections whose own user's other entries were held back (see the module comment). */
  private readonly heldBack = new Set<O>();
  private counter = 0;

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private nextClock(): number {
    this.counter = Math.max(this.counter + 1, this.now());
    return this.counter;
  }

  /** The number of live (non-removed) states. */
  get size(): number {
    let count = 0;
    for (const client of this.clients.values()) if (client.state !== null) count++;
    return count;
  }

  /** The live states, for tests and diagnostics. */
  states(): Map<number, State> {
    const states = new Map<number, State>();
    for (const [id, client] of this.clients) if (client.state) states.set(id, client.state);
    return states;
  }

  /**
   * Applies an awareness update from `owner`, a connection authenticated as
   * `user`. Throws MalformedMessage if the update can't be decoded. Entries
   * the connection may not write (another connection's clientID, a second
   * clientID, oversized states, stale clocks) are silently dropped.
   */
  apply(owner: O, user: AwarenessUser, update: Uint8Array): AwarenessBroadcast {
    const decoder = decoding.createDecoder(update);
    const changed: number[] = [];
    const ownedBefore = this.ownedBy.has(owner);
    try {
      const count = decoding.readVarUint(decoder);
      if (count > MAX_ENTRIES_PER_MESSAGE) throw new MalformedMessage("too many awareness entries");
      for (let i = 0; i < count; i++) {
        const clientId = decoding.readVarUint(decoder);
        const clock = decoding.readVarUint(decoder);
        const stateBytes = decoding.readVarUint8Array(decoder);
        if (clientId > MAX_CLIENT_ID || !Number.isSafeInteger(clock)) {
          throw new MalformedMessage("awareness entry out of range");
        }
        if (this.applyEntry(owner, user, clientId, clock, stateBytes)) changed.push(clientId);
      }
    } catch (error) {
      if (error instanceof MalformedMessage) throw error;
      throw new MalformedMessage("truncated awareness update");
    }
    if (decoding.hasContent(decoder)) throw new MalformedMessage("trailing awareness bytes");
    // Its first announcement: send what encodeAll held back.
    const caughtUp =
      !ownedBefore && this.ownedBy.has(owner) && this.heldBack.delete(owner)
        ? this.freshEntries((client) => client.userId === user.id && client.owner !== owner)
        : [];
    if (changed.length === 0 && caughtUp.length === 0) return { forOwner: null, forPeers: null };
    return {
      forOwner: encodeEntries([...this.entries(changed, owner), ...caughtUp]),
      forPeers: changed.length === 0 ? null : this.encode(changed),
    };
  }

  private applyEntry(
    owner: O,
    user: AwarenessUser,
    clientId: number,
    clock: number,
    stateBytes: Uint8Array,
  ): boolean {
    const existing = this.clients.get(clientId);
    const ownsOne = this.ownedBy.has(owner);
    // A claim: the connection's first clientID, either new or taken over
    // from the same user's older connection (see the module comment).
    let claiming = false;
    if (existing === undefined) {
      if (ownsOne) return false; // a second clientID
      claiming = true;
    } else if (existing.owner !== owner) {
      if (ownsOne || existing.userId !== user.id) return false; // someone else's
      claiming = true;
    }
    // Only the connection's own entry is parsed: relayed copies of others'
    // states are dropped above without spending time on them.
    if (stateBytes.length > MAX_STATE_BYTES) return false;
    const parsed = parseState(stateBytes);
    if (claiming) {
      if (parsed === null) return false; // nothing to claim
    } else {
      const newer = clock > existing!.clientClock;
      const removal =
        clock === existing!.clientClock && parsed === null && existing!.state !== null;
      if (!newer && !removal) return false;
    }
    let client = existing;
    if (client === undefined) {
      client = {
        owner,
        userId: user.id,
        clientClock: clock,
        clock: 0,
        state: null,
        lastUpdated: 0,
      };
      this.clients.set(clientId, client);
    } else if (claiming) {
      // The old connection keeps its ownedBy entry, so it can't claim any
      // other ID, but it no longer owns this one (removeOwner checks).
      client.owner = owner;
    }
    if (claiming) this.ownedBy.set(owner, clientId);
    client.clientClock = clock;
    client.clock = this.nextClock();
    client.state = parsed === null ? null : { ...parsed, user };
    client.lastUpdated = this.now();
    return true;
  }

  /**
   * An awareness update with the given clients' current states. With
   * `viewer`, that connection's own entries carry its own clock (see the
   * module comment).
   */
  encode(clientIds: Iterable<number>, viewer?: O): Uint8Array {
    return encodeEntries(this.entries(clientIds, viewer));
  }

  private entries(clientIds: Iterable<number>, viewer?: O): Entry[] {
    const entries: Entry[] = [];
    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (!client) continue;
      const clock =
        viewer !== undefined && client.owner === viewer ? client.clientClock : client.clock;
      entries.push({ clientId, clock, state: client.state });
    }
    return entries;
  }

  /** Live entries matching `include`, each given a fresh clock (stored). */
  private freshEntries(include: (client: Client<O>) => boolean): Entry[] {
    const entries: Entry[] = [];
    for (const [clientId, client] of this.clients) {
      if (client.state === null || !include(client)) continue;
      client.clock = this.nextClock();
      entries.push({ clientId, clock: client.clock, state: client.state });
    }
    return entries;
  }

  /**
   * Every live state, for connection `viewer` (signed in as `userId`) that
   * just joined or asked for them. Null if none. Others' entries get a fresh
   * clock (stored, so clocks stay increasing for every recipient). Until the
   * viewer has announced its own clientID, its user's entries on other
   * connections are held back; see the module comment.
   */
  encodeAll(viewer: O, userId: string): Uint8Array | null {
    const announced = this.ownedBy.has(viewer);
    const own = announced ? this.entries([this.ownedBy.get(viewer)!], viewer) : [];
    const others = this.freshEntries((client) => {
      if (client.owner === viewer) return false;
      if (!announced && client.userId === userId) {
        this.heldBack.add(viewer);
        return false;
      }
      return true;
    });
    const entries = [...own.filter((entry) => entry.state !== null), ...others];
    return entries.length === 0 ? null : encodeEntries(entries);
  }

  /**
   * Forgets everything `owner` announced (it disconnected). Returns the
   * removal to send to everyone else, or null if it had no live state.
   */
  removeOwner(owner: O): Uint8Array | null {
    this.heldBack.delete(owner);
    const clientId = this.ownedBy.get(owner);
    if (clientId === undefined) return null;
    this.ownedBy.delete(owner);
    const client = this.clients.get(clientId);
    if (!client || client.owner !== owner) return null; // taken over by a newer connection
    this.clients.delete(clientId);
    if (client.state === null) return null;
    return encodeEntries([{ clientId, clock: this.nextClock(), state: null }]);
  }

  /**
   * Removes states not renewed within OUTDATED_TIMEOUT_MS (a client that's
   * still connected but stopped renewing, e.g. a frozen tab). The owner keeps
   * the clientID and reappears with its next renewal. Returns, per owner, the
   * removal to send to everyone except that owner (whose client never accepts
   * a removal of its own state anyway).
   */
  sweep(): Array<{ owner: O; removal: Uint8Array }> {
    const cutoff = this.now() - OUTDATED_TIMEOUT_MS;
    const removals: Array<{ owner: O; removal: Uint8Array }> = [];
    for (const [clientId, client] of this.clients) {
      if (client.state === null || client.lastUpdated > cutoff) continue;
      client.state = null;
      client.clock = this.nextClock();
      removals.push({
        owner: client.owner,
        removal: encodeEntries([{ clientId, clock: client.clock, state: null }]),
      });
    }
    return removals;
  }
}
