import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { signTicket, verifyTicket, type Ticket } from "../src/ticket.ts";

const SECRET = Buffer.from("0123456789abcdef0123456789abcdef");
const NOW = 1_800_000_000;
const TICKET: Ticket = {
  userId: "6f1c3c1e-8a52-4b0e-9d7e-2f5f3b8c9a01",
  name: "Zoë 🚀",
  notebookId: "0b7a0d5e-1c2f-4e3a-9b8c-7d6e5f4a3b21",
  role: "editor",
};

function encode(payload: unknown, purpose = "sync-ticket", secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret).update(`${purpose}.${encoded}`).digest("base64url");
  return `${encoded}.${mac}`;
}

const VALID = {
  u: TICKET.userId,
  n: TICKET.name,
  nb: TICKET.notebookId,
  r: "editor",
  exp: NOW + 60,
};

describe("verifyTicket", () => {
  it("accepts a genuine, unexpired ticket", () => {
    expect(verifyTicket(signTicket(TICKET, SECRET, NOW + 60), SECRET, NOW)).toEqual(TICKET);
  });

  it("rejects expiry, a wrong key or purpose, and tampering", () => {
    expect(verifyTicket(signTicket(TICKET, SECRET, NOW), SECRET, NOW)).toBeNull();
    expect(
      verifyTicket(encode(VALID, "sync-ticket", Buffer.from("x".repeat(32))), SECRET, NOW),
    ).toBeNull();
    expect(verifyTicket(encode(VALID, "oauth-flow"), SECRET, NOW)).toBeNull();
    const [payload, mac] = signTicket(TICKET, SECRET, NOW + 60).split(".");
    const other = Buffer.from(JSON.stringify({ ...VALID, r: "owner" })).toString("base64url");
    expect(verifyTicket(`${other}.${mac}`, SECRET, NOW)).toBeNull();
    expect(verifyTicket(`${payload}.${mac}!`, SECRET, NOW)).toBeNull();
    expect(verifyTicket(`${payload}!.${mac}`, SECRET, NOW)).toBeNull();
    expect(verifyTicket(payload!, SECRET, NOW)).toBeNull();
    expect(verifyTicket("", SECRET, NOW)).toBeNull();
    expect(verifyTicket("a".repeat(5000), SECRET, NOW)).toBeNull();
  });

  it("rejects well-signed payloads with missing or malformed claims", () => {
    const bad = [
      [],
      "string",
      { ...VALID, exp: undefined },
      { ...VALID, exp: NOW + 0.5 },
      { ...VALID, exp: "9999999999" },
      { ...VALID, u: "not-a-uuid" },
      { ...VALID, nb: TICKET.notebookId.toUpperCase() },
      { ...VALID, r: "admin" },
      { ...VALID, n: 42 },
      { ...VALID, n: "x".repeat(201) },
    ];
    for (const payload of bad) expect(verifyTicket(encode(payload), SECRET, NOW)).toBeNull();
  });

  it("counts the name's length in characters, as the API does", () => {
    const emoji = "😀".repeat(200); // 400 UTF-16 units, 200 characters
    expect(verifyTicket(encode({ ...VALID, n: emoji }), SECRET, NOW)?.name).toBe(emoji);
    expect(verifyTicket(encode({ ...VALID, n: `${emoji}x` }), SECRET, NOW)).toBeNull();
  });

  it("verifies a ticket signed by the API's Python signer", () => {
    // The API's own tokens.sign, with a fixed clock, run through uv.
    const script = [
      "import json, sys",
      "from notebook_api.auth import tokens",
      "args = json.loads(sys.argv[1])",
      "print(tokens.sign(args['payload'], secret=args['secret'].encode('utf-8'),",
      "      purpose='sync-ticket', ttl_seconds=60, now=args['now']))",
    ].join("\n");
    const args = JSON.stringify({
      payload: { u: TICKET.userId, n: TICKET.name, nb: TICKET.notebookId, r: TICKET.role },
      secret: SECRET.toString("utf8"),
      now: NOW,
    });
    const apiDir = path.resolve(import.meta.dirname, "../../../services/api");
    const token = execFileSync("uv", ["run", "--directory", apiDir, "python", "-c", script, args], {
      encoding: "utf8",
    }).trim();
    expect(verifyTicket(token, SECRET, NOW)).toEqual(TICKET);
    expect(verifyTicket(token, SECRET, NOW + 60)).toBeNull();
    // And the test signer produces the very same bytes, non-ASCII name included.
    expect(signTicket(TICKET, SECRET, NOW + 60)).toBe(token);
  });
});
