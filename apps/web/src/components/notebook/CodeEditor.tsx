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
}

/**
 * A CodeMirror 6 editor bound to a Y.Text (the cell's source in the shared
 * document). yCollab keeps the two in sync both ways: local typing becomes Yjs
 * updates, and remote updates (Phase 2) appear in the editor.
 *
 * Undo/redo comes from Yjs's UndoManager, not CodeMirror's history: it only
 * undoes this user's own edits, never someone else's.
 */
export function CodeEditor({ text, language, placeholderText, onSubmit }: CodeEditorProps) {
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
        ...yUndoManagerKeymap,
        indentWithTab,
        ...defaultKeymap,
      ]),
      language === "sql" ? sql() : markdown(),
      yCollab(text, null, { undoManager }),
    ];
    if (placeholderText) extensions.push(placeholder(placeholderText));
    const view = new EditorView({
      state: EditorState.create({ doc: text.toString(), extensions }),
      parent: parent.current,
    });
    return () => {
      view.destroy();
      undoManager.destroy();
    };
  }, [text, language, placeholderText]);

  return (
    <div
      ref={parent}
      className="overflow-hidden rounded-md border border-zinc-200 text-sm dark:border-zinc-800 [&_.cm-editor]:min-h-[3rem] [&_.cm-editor.cm-focused]:outline-none"
    />
  );
}
