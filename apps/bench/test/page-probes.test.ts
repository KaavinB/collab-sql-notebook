// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { installAppearanceRecorder, installKeydownRecorder } from "../src/page-probes.ts";

/** y-codemirror.next's remote caret widget, as its toDOM builds it (word joiners included). */
function caret(name: string): string {
  return (
    '<span class="cm-ySelectionCaret" style="background-color: red">⁠' +
    '<div class="cm-ySelectionCaretDot"></div>⁠' +
    `<div class="cm-ySelectionInfo">${name}</div>⁠</span>`
  );
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function line(): HTMLElement {
  return document.querySelector(".cm-line")!;
}

describe("installAppearanceRecorder", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("counts the text, not a collaborator's caret or its name label", async () => {
    document.body.innerHTML =
      '<div data-cell-id="c1"><div class="cm-content">' +
      `<div class="cm-line">ab${caret("Grace Hopper")}c</div></div></div>`;
    expect(installAppearanceRecorder("c1")).toBe(3);

    line().append("d");
    await flush();
    expect(window.__benchAppeared!.map(([length]) => length)).toEqual([4]);

    // The caret moving (re-rendered elsewhere, with a longer name) adds no text.
    line().innerHTML = `${caret("Someone With A Long Name")}abcd`;
    await flush();
    expect(window.__benchAppeared).toHaveLength(1);
    expect(window.__benchTextLength!()).toBe(4);
  });

  it("counts a remote selection's highlighted text, which is real text", () => {
    document.body.innerHTML =
      '<div data-cell-id="c1"><div class="cm-content">' +
      '<div class="cm-line">a<span class="cm-ySelection">bc</span></div></div></div>';
    expect(installAppearanceRecorder("c1")).toBe(3);
  });

  it("ignores the empty editor's placeholder, and counts line breaks", async () => {
    document.body.innerHTML =
      '<div data-cell-id="c1"><div class="cm-content">' +
      '<div class="cm-line"><span class="cm-placeholder">Write SQL…</span></div></div></div>';
    expect(installAppearanceRecorder("c1")).toBe(0);

    line().innerHTML = "x";
    await flush();
    const second = document.createElement("div");
    second.className = "cm-line";
    second.textContent = "yz";
    document.querySelector(".cm-content")!.append(second);
    await flush();
    // "x", then "x\nyz": lengths 1, then 2, 3 and 4 at once.
    const appeared = window.__benchAppeared!;
    expect(appeared.map(([length]) => length)).toEqual([1, 2, 3, 4]);
    expect(appeared[1]![1]).toBe(appeared[3]![1]);
  });

  it("only watches its own cell", async () => {
    document.body.innerHTML =
      '<div data-cell-id="c1"><div class="cm-content"><div class="cm-line">a</div></div></div>' +
      '<div data-cell-id="c2"><div class="cm-content"><div class="cm-line">b</div></div></div>';
    installAppearanceRecorder("c1");
    document.querySelector('[data-cell-id="c2"] .cm-line')!.append("more");
    await flush();
    expect(window.__benchAppeared).toEqual([]);
  });

  it("refuses a cell that isn't on the page", () => {
    expect(() => installAppearanceRecorder("missing")).toThrow(/isn't on the page/);
  });
});

describe("installKeydownRecorder", () => {
  // Only the count is checked here: jsdom sets event.timeStamp from the
  // epoch, where browsers measure it from timeOrigin (which the recorder
  // relies on), so the time itself can only be checked in a real browser
  // (the benchmark's own runs: keydown times land next to the watcher's).
  it("records one time per keydown, not per keyup", () => {
    installKeydownRecorder();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "a" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    expect(window.__benchKeydowns).toHaveLength(2);
  });
});
