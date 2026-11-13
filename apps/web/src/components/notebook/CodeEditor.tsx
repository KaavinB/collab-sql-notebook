"use client";

import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { sql } from "@codemirror/lang-sql";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";

interface CodeEditorProps {
  text: Y.Text;
  language: "sql" | "markdown";
  placeholderText?: string;
  /** Runs on Mod-Enter (Cmd on macOS, Ctrl elsewhere). */
  onSubmit?: () => void;
  /** View only: the text can be read, selected and copied, never changed. */
  readOnly?: boolean;
}

/**
 * The extensions that make an editor view-only. `EditorState.readOnly`
 * refuses every change from user input (typing, paste, drop, commands);
 * `EditorView.editable(false)` also removes contenteditable, so the browser
 * shows no caret and screen readers announce the text as read-only.
 * Remote changes from collaborators still arrive through yCollab.
 */
export function readOnlyExtensions(): Extension[] {
  return [EditorState.readOnly.of(true), EditorView.editable.of(false)];
}

/**
 * A CodeMirror 6 editor bound to a Y.Text (the cell's source in the shared
 * document). yCollab keeps the two in sync both ways: local typing becomes Yjs
 * updates, and remote updates (Phase 2) appear in the editor.
 *
 * Undo/redo comes from Yjs's UndoManager, not CodeMirror's history: it only
 * undoes this user's own edits, never someone else's.
 */
export function CodeEditor({
  text,
  language,
  placeholderText,
  onSubmit,
  readOnly = false,
}: CodeEditorProps) {
  const parent = useRef<HTMLDivElement>(null);
  // The latest onSubmit, without rebuilding the editor when it changes.
  const submit = useRef(onSubmit);
  useEffect(() => {
    submit.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    if (!parent.current) return;
    const undoManager = new Y.UndoManager(text);
    const extensions: Extension[] = [
      lineNumbers(),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.lineWrapping,
      keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            submit.current?.();
            return true;
          },
        },
        // Yjs undo writes to the Y.Text directly, past CodeMirror's
        // read-only check, so a view-only editor doesn't bind it at all.
        ...(readOnly ? [] : yUndoManagerKeymap),
        // Tab moves focus out of a view-only editor instead of indenting.
        ...(readOnly ? [] : [indentWithTab]),
        ...defaultKeymap,
      ]),
      language === "sql" ? sql() : markdown(),
      yCollab(text, null, { undoManager }),
    ];
    if (placeholderText && !readOnly) extensions.push(placeholder(placeholderText));
    if (readOnly) extensions.push(...readOnlyExtensions());
    const view = new EditorView({
      state: EditorState.create({ doc: text.toString(), extensions }),
      parent: parent.current,
    });
    return () => {
      view.destroy();
      undoManager.destroy();
    };
  }, [text, language, placeholderText, readOnly]);

  return (
    <div
      ref={parent}
      className="overflow-hidden rounded-md border border-zinc-200 text-sm dark:border-zinc-800 [&_.cm-editor]:min-h-[3rem] [&_.cm-editor.cm-focused]:outline-none"
    />
  );
}
