/**
 * Questions waiting to be sent to the AI assistant for a cell that was just
 * created (from the empty-notebook box, an example question or the data
 * guide). The cell's own assistant sends the question once it's on the page,
 * through the same code path as typing it into the cell's box, so the
 * one-request-per-cell and busy rules still apply.
 *
 * Module state, local to this tab: nobody else should ask on our behalf.
 */
const pending = new Map<string, string>();

export function queueQuestion(cellId: string, question: string): void {
  pending.set(cellId, question);
}

/** The question waiting for this cell, removed so it's only asked once. */
export function takeQuestion(cellId: string): string | null {
  const question = pending.get(cellId) ?? null;
  pending.delete(cellId);
  return question;
}
