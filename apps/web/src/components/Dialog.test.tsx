// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Dialog, SIDE_PANEL_ATTRIBUTE } from "@/components/Dialog";

afterEach(cleanup);

function Harness({ side = false }: { side?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <input aria-label="Outside" />
      {open && (
        <Dialog title="Settings" side={side} onClose={() => setOpen(false)}>
          <input aria-label="First" />
          <button>Last</button>
        </Dialog>
      )}
    </>
  );
}

function openWith(side = false) {
  render(<Harness side={side} />);
  const opener = screen.getByRole("button", { name: "Open" });
  opener.focus();
  fireEvent.click(opener);
  return { opener, dialog: screen.getByRole("dialog", { name: "Settings" }) };
}

describe("a modal dialog", () => {
  it("takes focus, and gives it back to the button that opened it", () => {
    const { opener, dialog } = openWith();
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps Tab inside the dialog", () => {
    openWith();
    const close = screen.getByRole("button", { name: "Close" });
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("closes on a click on the backdrop, but not on a drag that ends there", () => {
    openWith();
    const backdrop = screen.getByTestId("dialog-backdrop");
    // Pressed inside (selecting text), released on the backdrop.
    fireEvent.mouseDown(screen.getByLabelText("First"));
    fireEvent.mouseUp(backdrop);
    expect(screen.queryByRole("dialog")).not.toBeNull();
    // Pressed inside and released inside.
    fireEvent.mouseDown(screen.getByRole("dialog"));
    fireEvent.mouseUp(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a side panel", () => {
  it("makes room on the page while open", () => {
    openWith(true);
    expect(document.documentElement.hasAttribute(SIDE_PANEL_ATTRIBUTE)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.documentElement.hasAttribute(SIDE_PANEL_ATTRIBUTE)).toBe(false);
  });

  it("leaves Escape to the page while focus is outside it", () => {
    const { opener } = openWith(true);
    screen.getByLabelText("Outside").focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeNull();
    // Not modal: Tab isn't trapped either.
    expect(screen.queryByTestId("dialog-backdrop")).toBeNull();
    screen.getByLabelText("First").focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
