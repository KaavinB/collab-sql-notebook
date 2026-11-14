/**
 * Code that runs inside the benchmark's browser pages (passed to
 * page.evaluate, so each function must be self-contained: no imports, no
 * references to anything outside its own body).
 *
 * Both pages time with performance.timeOrigin + performance.now(): ms since
 * the epoch, the clock the latency benchmark corrects with round trips.
 */

declare global {
  interface Window {
    __benchKeydowns?: number[];
    __benchAppeared?: Array<[number, number]>;
    __benchTextLength?: () => number;
  }
}

/** Typing page: records every keydown's time, as early as the page sees it. */
export function installKeydownRecorder(): void {
  const keydowns: number[] = [];
  window.__benchKeydowns = keydowns;
  window.addEventListener(
    "keydown",
    (event) => {
      // event.timeStamp is when the browser created the event (ms since
      // timeOrigin), which is earlier than when this listener runs.
      keydowns.push(performance.timeOrigin + event.timeStamp);
    },
    { capture: true },
  );
}

/**
 * Watching page: records the first moment the cell's text reached each
 * length. The text is what CodeMirror shows, minus collaborators' carets
 * (drawn inline with a name label) and the empty editor's placeholder.
 * Returns the length now.
 */
export function installAppearanceRecorder(cellId: string): number {
  const cell = document.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`);
  if (!cell) throw new Error(`cell ${cellId} isn't on the page`);
  const skip = ".cm-ySelectionCaret, .cm-ySelectionInfo, .cm-placeholder";
  const textLength = (): number => {
    const content = cell.querySelector(".cm-content");
    if (!content) return -1;
    const lines = content.querySelectorAll(".cm-line");
    let length = Math.max(0, lines.length - 1); // the line breaks
    for (const line of lines) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.parentElement?.closest(skip)) length += (node as Text).data.length;
      }
    }
    return length;
  };
  const appeared: Array<[number, number]> = [];
  window.__benchAppeared = appeared;
  window.__benchTextLength = textLength;
  let longest = textLength();
  new MutationObserver(() => {
    const now = performance.timeOrigin + performance.now();
    const length = textLength();
    for (let reached = longest + 1; reached <= length; reached++) appeared.push([reached, now]);
    longest = Math.max(longest, length);
  }).observe(cell, { subtree: true, childList: true, characterData: true });
  return longest;
}

export function readClock(): number {
  return performance.timeOrigin + performance.now();
}
