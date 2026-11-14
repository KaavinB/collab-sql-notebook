"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

import { iconButton } from "@/components/ui";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Set on <html> while a side panel is open; globals.css makes room for it on wide screens. */
export const SIDE_PANEL_ATTRIBUTE = "data-side-panel";

/**
 * A modal dialog (a centered panel over a dimmed page), or a side panel
 * (`side`) for reference material people read while they keep working.
 *
 * Modal: Tab and Shift+Tab stay inside the dialog, Escape and the close
 * button close it, and so does a click on the dimmed backdrop (a press and a
 * release both on the backdrop, so selecting text inside and releasing
 * outside doesn't close it).
 *
 * Side panel: not modal. The page stays usable, so Escape closes the panel
 * only while focus is inside it (it would otherwise also cancel things on the
 * page, like a title rename). On wide screens the page moves over to make
 * room instead of being covered.
 *
 * Either way, focus moves into the panel when it opens and back to whatever
 * had it (usually the button that opened it) when it closes, so keyboard
 * users don't lose their place.
 */
export function Dialog({
  title,
  description,
  onClose,
  side = false,
  children,
  wide = false,
}: {
  title: string;
  description?: React.ReactNode;
  onClose: () => void;
  side?: boolean;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  // Whether the current mouse press started on the backdrop.
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const node = panel.current;
      if (!node) return;
      if (event.key === "Escape") {
        if (side && !node.contains(document.activeElement)) return;
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key === "Tab" && !side) {
        const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) {
          event.preventDefault();
          node.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === node)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !node.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    if (side) document.documentElement.setAttribute(SIDE_PANEL_ATTRIBUTE, "open");
    return () => {
      document.removeEventListener("keydown", onKey);
      if (side) document.documentElement.removeAttribute(SIDE_PANEL_ATTRIBUTE);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [side]);

  const body = (
    <div
      ref={panel}
      role="dialog"
      aria-modal={side ? undefined : true}
      aria-labelledby={titleId}
      tabIndex={-1}
      className={
        side
          ? "fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-2xl outline-none dark:border-zinc-800 dark:bg-zinc-950"
          : `relative flex max-h-[85vh] w-full ${wide ? "max-w-2xl" : "max-w-lg"} flex-col rounded-xl bg-white shadow-2xl outline-none dark:bg-zinc-950`
      }
    >
      <header className="flex items-start gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
        <div className="flex-1 space-y-1">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
          {description && (
            <div className="text-sm text-zinc-600 dark:text-zinc-400">{description}</div>
          )}
        </div>
        <button className={iconButton} onClick={onClose} aria-label="Close" title="Close (Esc)">
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="h-4 w-4 stroke-current stroke-[1.5]"
          >
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
    </div>
  );

  // Rendered into <body>: a fixed element inside a parent with a backdrop
  // filter or transform (the notebook's sticky header has one) is positioned
  // and clipped relative to that parent instead of the window.
  if (side) return createPortal(body, document.body);
  return createPortal(
    <div
      data-testid="dialog-backdrop"
      className="fixed inset-0 z-40 flex items-center justify-center bg-zinc-900/40 p-4 backdrop-blur-[1px]"
      onMouseDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onMouseUp={(event) => {
        if (pressedBackdrop.current && event.target === event.currentTarget) close.current();
        pressedBackdrop.current = false;
      }}
    >
      {body}
    </div>,
    document.body,
  );
}
