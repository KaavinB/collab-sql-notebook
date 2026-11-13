/**
 * Verifies the short-lived tickets the API hands out for opening a sync
 * connection (POST /notebooks/{id}/sync-ticket).
 *
 * Same format as the API's signer (services/api/src/notebook_api/auth/tokens.py):
 *   base64url(JSON payload) "." base64url(HMAC-SHA256(secret, purpose "." payload))
 * base64url without padding. The purpose ("sync-ticket") is part of what's
 * signed, so no other token the API signs can be passed off as a ticket.
 *
 * Why a ticket and not the session cookie: the sync server then never sees
 * a session token and doesn't depend on browsers sending cookies on
 * cross-origin WebSocket upgrades. A ticket lives 60 seconds; it only has to
 * survive until the socket opens.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const TICKET_PURPOSE = "sync-ticket";
// Same cap as the API's verifier. Real tickets are a few hundred bytes.
const MAX_TICKET_LENGTH = 4096;
// Same cap as users.name in the database, in code points (characters), as
// the API counts them: "".length counts UTF-16 units, an emoji is two.
const MAX_NAME_LENGTH = 200;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Role = "owner" | "editor" | "viewer";
const ROLES: readonly string[] = ["owner", "editor", "viewer"];

export interface Ticket {
  userId: string;
  name: string;
  notebookId: string;
  role: Role;
}

function mac(secret: Buffer, encodedPayload: string): Buffer {
  return createHmac("sha256", secret).update(`${TICKET_PURPOSE}.${encodedPayload}`).digest();
}

/** The ticket's claims if it's genuine and unexpired; null otherwise. */
export function verifyTicket(
  token: string,
  secret: Buffer,
  nowSeconds: number = Date.now() / 1000,
): Ticket | null {
  if (token.length > MAX_TICKET_LENGTH) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  // Node's base64url decoder skips characters outside the alphabet instead
  // of failing, so check the alphabet first: "abc!" must not verify as "abc".
  if (!BASE64URL.test(encoded) || !BASE64URL.test(signature)) return null;
  const given = Buffer.from(signature, "base64url");
  const expected = mac(secret, encoded);
  // Constant time, so timing can't reveal how much of a forged MAC matched.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const { exp, u, n, nb, r } = payload as Record<string, unknown>;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= nowSeconds) return null;
  if (typeof u !== "string" || !UUID_PATTERN.test(u)) return null;
  if (typeof nb !== "string" || !UUID_PATTERN.test(nb)) return null;
  if (typeof n !== "string" || [...n].length > MAX_NAME_LENGTH) return null;
  if (typeof r !== "string" || !ROLES.includes(r)) return null;
  return { userId: u, name: n, notebookId: nb, role: r as Role };
}

/**
 * JSON exactly as Python's `json.dumps(..., separators=(",", ":"),
 * sort_keys=True)` writes it, including its default `ensure_ascii`
 * (non-ASCII as \uXXXX escapes). Only flat objects of strings and numbers.
 */
function pythonJson(body: Record<string, string | number>): string {
  const keys = Object.keys(body).sort();
  const parts = keys.map((key) => {
    const value = JSON.stringify(body[key]).replace(
      /[\u0080-￿]/g,
      (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    return `${JSON.stringify(key)}:${value}`;
  });
  return `{${parts.join(",")}}`;
}

/** Signs a ticket. The API is the only real issuer; this exists for tests and tools. */
export function signTicket(ticket: Ticket, secret: Buffer, expSeconds: number): string {
  const body = {
    exp: expSeconds,
    n: ticket.name,
    nb: ticket.notebookId,
    r: ticket.role,
    u: ticket.userId,
  };
  const encoded = Buffer.from(pythonJson(body), "utf8").toString("base64url");
  return `${encoded}.${mac(secret, encoded).toString("base64url")}`;
}
