/**
 * The wire protocol: the same binary messages y-websocket's client speaks.
 *
 * Every WebSocket message is one binary frame:
 *   varUint messageType, then a body that depends on the type.
 *
 *   0 sync        varUint subtype, varUint8Array payload
 *                   subtype 0 step1:  the sender's state vector ("what I have")
 *                   subtype 1 step2:  an update with what the other side lacks
 *                   subtype 2 update: an incremental update
 *   1 awareness   varUint8Array awareness update (see awareness.ts)
 *   2 auth        y-websocket's permission-denied message; ignored here
 *   3 query awareness  no body: "send me every awareness state"
 *
 * A varUint is 7 bits per byte, low bits first, high bit = "more bytes";
 * a varUint8Array is a varUint length followed by that many bytes.
 *
 * The handshake: the client sends step1; the server replies step2 (what the
 * client is missing) and, for editors, its own step1, which the client answers
 * with step2 (whatever it changed while offline). After that both sides just
 * send updates.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_AUTH = 2;
export const MESSAGE_QUERY_AWARENESS = 3;

export const SYNC_STEP1 = 0;
export const SYNC_STEP2 = 1;
export const SYNC_UPDATE = 2;

/** WebSocket close codes. The browser's provider decides what to do from these. */
export const CloseCode = {
  /** The server is shutting down or restarting; reconnect. */
  goingAway: 1001,
  /** Server-side failure (couldn't load the document); reconnect. */
  serverError: 1011,
  /** The server restarts; reconnect. */
  restart: 1012,
  /** The client isn't reading fast enough; reconnect. */
  tryAgainLater: 1013,
  malformed: 4400,
  /** Missing, invalid or expired ticket: fetch a new ticket and reconnect. */
  badTicket: 4401,
  /** Access changed or was revoked: fetch a new ticket (the API says if access remains). */
  accessChanged: 4403,
  /** The notebook was deleted: stop. */
  notebookDeleted: 4404,
  messageTooLarge: 4413,
} as const;

/** A message the server can't or won't parse. The connection is closed with 4400. */
export class MalformedMessage extends Error {}

export function syncMessage(subtype: number, payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarUint(encoder, subtype);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

export function awarenessMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

export type IncomingMessage =
  | { kind: "sync-step1"; stateVector: Uint8Array }
  | { kind: "sync-update"; update: Uint8Array } // step2 or update: both carry an update
  | { kind: "awareness"; update: Uint8Array }
  | { kind: "query-awareness" }
  | { kind: "auth" };

/**
 * Parses one incoming frame. Throws MalformedMessage for anything that isn't
 * exactly one well-formed message (unknown types, truncated bodies, trailing
 * bytes). The payloads themselves (state vectors, updates, awareness) are
 * checked by their consumers.
 */
export function parseMessage(data: Uint8Array): IncomingMessage {
  const decoder = decoding.createDecoder(data);
  let message: IncomingMessage;
  try {
    const type = decoding.readVarUint(decoder);
    switch (type) {
      case MESSAGE_SYNC: {
        const subtype = decoding.readVarUint(decoder);
        const payload = decoding.readVarUint8Array(decoder);
        if (subtype === SYNC_STEP1) message = { kind: "sync-step1", stateVector: payload };
        else if (subtype === SYNC_STEP2 || subtype === SYNC_UPDATE) {
          message = { kind: "sync-update", update: payload };
        } else throw new MalformedMessage(`unknown sync subtype ${subtype}`);
        break;
      }
      case MESSAGE_AWARENESS:
        message = { kind: "awareness", update: decoding.readVarUint8Array(decoder) };
        break;
      case MESSAGE_QUERY_AWARENESS:
        message = { kind: "query-awareness" };
        break;
      case MESSAGE_AUTH:
        // Only servers send auth messages (permission denied); a client has
        // no reason to, so its body isn't parsed.
        return { kind: "auth" };
      default:
        throw new MalformedMessage(`unknown message type ${type}`);
    }
  } catch (error) {
    if (error instanceof MalformedMessage) throw error;
    // lib0 throws plain Errors for truncated input.
    throw new MalformedMessage("truncated message");
  }
  if (decoding.hasContent(decoder)) throw new MalformedMessage("trailing bytes");
  return message;
}
