/**
 * A share link's token, kept in this tab while its visitor signs in.
 *
 * Signing in with GitHub or Google leaves the site and comes back to a
 * `next` path, which travels through the API's sign-in URL and its flow
 * cookie. Putting /share/<token> there would copy a live token into the
 * API's access logs. So the share page remembers the token here and signs
 * in with next=/share; that page picks it up again.
 *
 * sessionStorage is per tab and cleared when the tab closes. Every access is
 * guarded: it can throw (blocked storage, some private modes), and then the
 * visitor just opens the link again after signing in.
 */
const KEY = "notebook.pendingShareToken";

export function rememberShareToken(token: string): void {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    // Storage unavailable: nothing to remember it in.
  }
}

export function pendingShareToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function forgetShareToken(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing was stored.
  }
}
