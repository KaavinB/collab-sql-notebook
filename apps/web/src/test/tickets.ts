/**
 * A ticket-shaped token naming `user`, like the API's: base64url JSON with a
 * `u` claim, then a signature. Unsigned here: only the client reads it, to
 * notice a ticket issued to someone else; the sync server verifies them.
 */
export function ticketFor(user: string, nonce = "t"): string {
  const payload = btoa(JSON.stringify({ u: user, n: nonce }))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${payload}.signature`;
}
