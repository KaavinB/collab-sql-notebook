// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { CodeEditor, readOnlyExtensions } from "@/components/notebook/CodeEditor";

afterEach(cleanup);

function textWith(value: string): Y.Text {
  const doc = new Y.Doc();
  const text = doc.getText("t");
  text.insert(0, value);
  return text;
}

describe("CodeEditor", () => {
  it("makes the state read-only and the view non-editable for viewers", () => {
    const state = EditorState.create({ doc: "select 1", extensions: readOnlyExtensions() });
    expect(state.readOnly).toBe(true);
    expect(state.facet(EditorView.editable)).toBe(false);
  });

  it("renders a viewer's editor without contenteditable", () => {
    const { container } = render(
      <CodeEditor text={textWith("select 1")} language="sql" readOnly />,
    );
    const content = container.querySelector(".cm-content");
    expect(content?.getAttribute("contenteditable")).toBe("false");
    expect(content?.textContent).toBe("select 1");
  });

  it("leaves an editor's editor editable", () => {
    const { container } = render(<CodeEditor text={textWith("select 1")} language="sql" />);
    expect(container.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
  });
});
