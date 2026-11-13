/** Pure units: awareness rules, message parsing, config, NOTIFY payloads. */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";

import {
  colorFor,
  MAX_STATE_BYTES,
  OUTDATED_TIMEOUT_MS,
  PALETTE,
  RoomAwareness,
  type AwarenessUser,
} from "../src/awareness.ts";
import { ConfigError, loadConfig, toPgUrl } from "../src/config.ts";
import { parseEvent } from "../src/notify.ts";
import { MalformedMessage, parseMessage } from "../src/protocol.ts";

function update(entries: Array<[number, number, unknown]>): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const [id, clock, state] of entries) {
    encoding.writeVarUint(encoder, id);
    encoding.writeVarUint(encoder, clock);
    encoding.writeVarString(encoder, typeof state === "string" ? state : JSON.stringify(state));
  }
  return encoding.toUint8Array(encoder);
}

function decode(bytes: Uint8Array | null): Array<[number, number, unknown]> {
  if (!bytes) return [];
  const decoder = decoding.createDecoder(bytes);
  const count = decoding.readVarUint(decoder);
  const entries: Array<[number, number, unknown]> = [];
  for (let i = 0; i < count; i++) {
    entries.push([
      decoding.readVarUint(decoder),
      decoding.readVarUint(decoder),
      JSON.parse(decoding.readVarString(decoder)),
    ]);
  }
  return entries;
}

const ALICE: AwarenessUser = { id: "a", name: "Alice", color: "#111111" };
const BOB: AwarenessUser = { id: "b", name: "Bob", color: "#222222" };

describe("RoomAwareness", () => {
  function setup() {
    let now = 1_000_000;
    const awareness = new RoomAwareness<string>(() => now);
    return { awareness, advance: (ms: number) => (now += ms) };
  }

  it("stamps the ticket's user over whatever the client sent", () => {
    const { awareness } = setup();
    const result = awareness.apply("connA", ALICE, update([[1, 0, { user: BOB, x: 1 }]]));
    const [[id, clock, state]] = decode(result.forPeers) as [[number, number, unknown]];
    expect(id).toBe(1);
    expect(clock).toBeGreaterThan(0);
    expect(state).toEqual({ user: ALICE, x: 1 });
    // The owner gets its own clock back (it ignores the echo).
    expect(decode(result.forOwner)).toEqual([[1, 0, { user: ALICE, x: 1 }]]);
  });

  it("lets a connection own one clientID and nobody else write it", () => {
    const { awareness } = setup();
    awareness.apply("connA", ALICE, update([[1, 0, { x: 1 }]]));
    expect(awareness.apply("connB", BOB, update([[1, 99, { x: "hijack" }]])).forPeers).toBeNull();
    expect(awareness.apply("connA", ALICE, update([[2, 0, { x: 2 }]])).forPeers).toBeNull();
    expect(awareness.states().get(1)).toEqual({ x: 1, user: ALICE });
    expect(awareness.states().has(2)).toBe(false);
  });

  it("lets the same user's new connection take over its clientID", () => {
    const { awareness } = setup();
    awareness.apply("old", ALICE, update([[1, 4, { x: 1 }]]));
    // The reconnect announces the same clock it had: still accepted.
    const takeover = awareness.apply("new", ALICE, update([[1, 4, { x: 2 }]]));
    expect(decode(takeover.forPeers)[0]![2]).toEqual({ x: 2, user: ALICE });
    // The old socket can no longer write it, and closing it removes nothing.
    expect(awareness.apply("old", ALICE, update([[1, 9, { x: 3 }]])).forPeers).toBeNull();
    expect(awareness.removeOwner("old")).toBeNull();
    expect(awareness.states().get(1)).toEqual({ x: 2, user: ALICE });
    // A connection that already owns an ID can't take over another.
    awareness.apply("other", ALICE, update([[2, 0, { y: 1 }]]));
    expect(awareness.apply("other", ALICE, update([[1, 10, { x: 4 }]])).forPeers).toBeNull();
  });

  it("applies only newer clocks, and removal at the same clock", () => {
    const { awareness } = setup();
    awareness.apply("c", ALICE, update([[1, 5, { x: 1 }]]));
    expect(awareness.apply("c", ALICE, update([[1, 5, { x: 2 }]])).forPeers).toBeNull();
    expect(awareness.apply("c", ALICE, update([[1, 4, { x: 2 }]])).forPeers).toBeNull();
    expect(awareness.apply("c", ALICE, update([[1, 6, { x: 3 }]])).forPeers).not.toBeNull();
    expect(decode(awareness.apply("c", ALICE, update([[1, 6, null]])).forPeers)[0]![2]).toBeNull();
    expect(awareness.size).toBe(0);
  });

  it("relays with a server clock that only grows, also across disconnects", () => {
    const { awareness } = setup();
    const first = decode(awareness.apply("c1", ALICE, update([[1, 3, { x: 1 }]])).forPeers);
    const removal = decode(awareness.removeOwner("c1"));
    // Same client reconnects with the same clock it had.
    const again = decode(awareness.apply("c2", ALICE, update([[1, 3, { x: 1 }]])).forPeers);
    expect(removal[0]![1]).toBeGreaterThan(first[0]![1]);
    expect(again[0]![1]).toBeGreaterThan(removal[0]![1]);
    expect(removal[0]![2]).toBeNull();
  });

  it("gives a joining connection fresh clocks for others, its own clock for itself", () => {
    const { awareness } = setup();
    const relayed = decode(awareness.apply("a", ALICE, update([[1, 5, { x: 1 }]])).forPeers);
    awareness.apply("b", BOB, update([[2, 7, { y: 1 }]]));
    const all = new Map(decode(awareness.encodeAll("b", BOB.id)).map(([id, c]) => [id, c]));
    expect(all.get(1)).toBeGreaterThan(relayed[0]![1]);
    expect(all.get(2)).toBe(7);
    // Later relays keep growing past the clock just handed out.
    const next = decode(awareness.apply("a", ALICE, update([[1, 6, { x: 2 }]])).forPeers);
    expect(next[0]![1]).toBeGreaterThan(all.get(1)!);
  });

  it("holds back the user's own other entries until a joining connection announces", () => {
    const { awareness } = setup();
    awareness.apply("oldTab", ALICE, update([[1, 3, { x: "old" }]]));
    awareness.apply("otherTab", ALICE, update([[2, 0, { x: "other" }]]));
    awareness.apply("bob", BOB, update([[9, 0, { y: 1 }]]));
    // Alice reconnects: before she announces, only other users are listed.
    expect(decode(awareness.encodeAll("newTab", ALICE.id)).map(([id]) => id)).toEqual([9]);
    // She announces clientID 1 (taking it over); the held-back entry for her
    // other tab follows, with a fresh clock; her own comes back with hers.
    const result = awareness.apply("newTab", ALICE, update([[1, 3, { x: "new" }]]));
    const forOwner = decode(result.forOwner);
    expect(forOwner.map(([id, clock]) => [id, id === 1 ? clock : "fresh"])).toEqual([
      [1, 3],
      [2, "fresh"],
    ]);
    expect(forOwner[1]![1]).toBeGreaterThan(1_000_000);
  });

  it("drops oversized states and rejects undecodable ones", () => {
    const { awareness } = setup();
    const big = { blob: "x".repeat(MAX_STATE_BYTES) };
    expect(awareness.apply("c", ALICE, update([[1, 0, big]])).forPeers).toBeNull();
    expect(() => awareness.apply("c", ALICE, update([[1, 0, "{not json"]]))).toThrow(
      MalformedMessage,
    );
    expect(() => awareness.apply("c", ALICE, update([[1, 0, "[1,2]"]]))).toThrow(MalformedMessage);
    expect(() => awareness.apply("c", ALICE, new Uint8Array([1, 1]))).toThrow(MalformedMessage);
    const trailing = new Uint8Array([...update([[1, 0, {}]]), 0]);
    expect(() => awareness.apply("c", ALICE, trailing)).toThrow(MalformedMessage);
  });

  it("sweeps states that weren't renewed, keeping ownership", () => {
    const { awareness, advance } = setup();
    awareness.apply("c", ALICE, update([[1, 0, { x: 1 }]]));
    advance(OUTDATED_TIMEOUT_MS - 1);
    expect(awareness.sweep()).toEqual([]);
    advance(2);
    const removals = awareness.sweep();
    expect(removals.map((r) => r.owner)).toEqual(["c"]);
    expect(decode(removals[0]!.removal)[0]![2]).toBeNull();
    expect(awareness.size).toBe(0);
    // Its next renewal brings it back.
    expect(awareness.apply("c", ALICE, update([[1, 1, { x: 1 }]])).forPeers).not.toBeNull();
    expect(awareness.size).toBe(1);
  });

  it("picks a stable palette color per user", () => {
    expect(colorFor("user-1")).toBe(colorFor("user-1"));
    expect(PALETTE).toContain(colorFor("user-2"));
  });
});

describe("parseMessage", () => {
  it("parses the message types y-websocket sends", () => {
    expect(parseMessage(new Uint8Array([0, 0, 1, 7])).kind).toBe("sync-step1");
    expect(parseMessage(new Uint8Array([0, 1, 0])).kind).toBe("sync-update");
    expect(parseMessage(new Uint8Array([0, 2, 0])).kind).toBe("sync-update");
    expect(parseMessage(new Uint8Array([1, 1, 0])).kind).toBe("awareness");
    expect(parseMessage(new Uint8Array([3])).kind).toBe("query-awareness");
  });

  it("rejects unknown, truncated and padded messages", () => {
    for (const bad of [[], [7], [0, 3, 0], [0, 0, 5, 1], [0, 0, 0, 0], [3, 0], [0x80]]) {
      expect(() => parseMessage(new Uint8Array(bad))).toThrow(MalformedMessage);
    }
  });
});

describe("config", () => {
  const base = {
    SYNC_TICKET_SECRET: "s".repeat(32),
    DATABASE_URL: "postgresql+psycopg://u:p@127.0.0.1:5432/notebook",
  };

  it("reads defaults and converts the SQLAlchemy URL", () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 8020,
      databaseUrl: "postgresql://u:p@127.0.0.1:5432/notebook",
    });
    expect([...config.allowedOrigins]).toEqual(["http://localhost:3000"]);
    expect(toPgUrl("postgres://x@h/db")).toBe("postgresql://x@h/db");
  });

  it("refuses weak secrets, bad ports and non-origin entries", () => {
    expect(() => loadConfig({ ...base, SYNC_TICKET_SECRET: "short" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, DATABASE_URL: "" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, DATABASE_URL: "mysql://x" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SYNC_PORT: "http" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, SYNC_ALLOWED_ORIGINS: "http://a.com/path" })).toThrow(
      ConfigError,
    );
    const origins = loadConfig({ ...base, SYNC_ALLOWED_ORIGINS: "https://a.com, http://b:3000/" });
    expect([...origins.allowedOrigins]).toEqual(["https://a.com", "http://b:3000"]);
  });
});

describe("parseEvent", () => {
  const nb = "0b7a0d5e-1c2f-4e3a-9b8c-7d6e5f4a3b21";

  it("parses each event type", () => {
    expect(parseEvent(JSON.stringify({ type: "notebook_deleted", notebook_id: nb }))).toEqual({
      type: "notebook_deleted",
      notebookId: nb,
    });
    expect(
      parseEvent(
        JSON.stringify({
          type: "run_finished",
          notebook_id: nb.toUpperCase(),
          cell_id: "c1",
          execution_id: "e1",
          run_id: null,
        }),
      ),
    ).toEqual({
      type: "run_finished",
      notebookId: nb,
      cellId: "c1",
      executionId: "e1",
      runId: null,
    });
  });

  it("ignores malformed payloads and unknown types", () => {
    expect(parseEvent("nope")).toBeNull();
    expect(parseEvent("[]")).toBeNull();
    expect(parseEvent(JSON.stringify({ type: "later_feature", notebook_id: nb }))).toBeNull();
    expect(parseEvent(JSON.stringify({ type: "access_changed", notebook_id: nb }))).toBeNull();
    expect(
      parseEvent(
        JSON.stringify({
          type: "run_started",
          notebook_id: nb,
          cell_id: "c1",
          execution_id: "e1",
          user_name: "A",
          started_at: "yesterday",
        }),
      ),
    ).toBeNull();
  });
});
