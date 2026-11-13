/**
 * Work that must finish before the session ends, such as a notebook's final
 * save when its page unmounts.
 *
 * Signing out first unmounts the signed-in pages (which starts their final
 * saves), then waits here, and only then ends the session. Ending it first
 * would make those saves fail as unauthenticated and drop the last edits.
 */
const pending = new Set<Promise<unknown>>();

export function trackPendingWork(work: Promise<unknown>): void {
  pending.add(work);
  const forget = () => pending.delete(work);
  work.then(forget, forget);
}

/** Resolves once all tracked work has settled, including work added meanwhile. */
export async function settlePendingWork(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}
