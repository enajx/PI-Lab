import { EditorView } from "@codemirror/view"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import {
  EDITOR_FONT_DEFAULT_FAMILY,
  useEditorFontFamily,
  useEditorFontSize,
} from "../../../preferences/preferences"
import { CodeMirrorBuffer } from "./CodeMirrorBuffer"

if (typeof Range.prototype.getClientRects !== "function") {
  Object.defineProperty(Range.prototype, "getClientRects", {
    value: () => [],
  })
}

function findEditor(container: HTMLElement): EditorView {
  const editorElement = container.querySelector(".cm-editor")
  if (!(editorElement instanceof HTMLElement)) throw new Error("CodeMirror editor did not mount")
  const editor = EditorView.findFromDOM(editorElement)
  if (!editor) throw new Error("CodeMirror view was not attached")
  return editor
}

describe("CodeMirrorBuffer theme reconfiguration", () => {
  test("changes built-in and imported themes live without remounting the editor view", () => {
    const props = {
      relPath: "main.py",
      initialDoc: "print('hi')\n",
      onChange: vi.fn(),
      onSave: vi.fn(),
    }
    const view = render(<CodeMirrorBuffer {...props} theme="one-dark" customThemes={[]} />)
    const editor = view.container.querySelector(".cm-editor")
    expect(editor).toBeTruthy()
    const originalClass = editor?.className

    const custom = {
      id: "custom:ocean:abc",
      name: "Ocean",
      mode: "dark" as const,
      colors: { background: "#102030", foreground: "#ddeeff" },
      tokenColors: [{ scopes: ["comment"], foreground: "#778899" }],
    }
    view.rerender(<CodeMirrorBuffer {...props} theme={custom.id} customThemes={[custom]} />)

    const reconfigured = view.container.querySelector(".cm-editor")
    expect(reconfigured).toBe(editor)
    expect(reconfigured?.className).not.toBe(originalClass)
  })
})

function LiveTypographyFixture() {
  const [, setFamily] = useEditorFontFamily()
  const [, setSize] = useEditorFontSize()
  return (
    <>
      <button type="button" onClick={() => setFamily("Avenir Next")}>
        family
      </button>
      <button type="button" onClick={() => setSize(19)}>
        size
      </button>
      <CodeMirrorBuffer
        relPath="main.py"
        initialDoc="print('hi')\n"
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    </>
  )
}

describe("CodeMirrorBuffer typography", () => {
  test("applies global family and size live to editor text and gutters", () => {
    window.localStorage.setItem("pi-lab.editor.fontFamily", EDITOR_FONT_DEFAULT_FAMILY)
    window.localStorage.setItem("pi-lab.editor.fontSize", "14")
    const rendered = render(<LiveTypographyFixture />)
    const editor = findEditor(rendered.container)
    editor.dispatch({ selection: { anchor: 3 } })
    const stateBeforeTypographyChange = editor.state

    fireEvent.click(screen.getByRole("button", { name: "family" }))
    fireEvent.click(screen.getByRole("button", { name: "size" }))

    const host = rendered.container.querySelector(".cm-editor")?.parentElement
    expect(host?.style.getPropertyValue("--pi-lab-editor-font-family")).toContain("Avenir Next")
    expect(host?.style.getPropertyValue("--pi-lab-editor-font-size")).toBe("19px")
    expect(editor.state).toBe(stateBeforeTypographyChange)
    expect(editor.state.selection.main).toMatchObject({ anchor: 3, head: 3 })
  })
})

describe("CodeMirrorBuffer Markdown editing", () => {
  test("Render keeps source editable while styling Markdown structure, and Source removes it", () => {
    const markdown = [
      "# Sponsor kit",
      "",
      "Everything **a sponsor needs**.",
      "",
      "- First placement",
      "",
      "| Stat | Value |",
      "| --- | --- |",
      "| Subscribers | 4,213 |",
    ].join("\n")
    const props = {
      relPath: "SPONSOR.md",
      initialDoc: markdown,
      onChange: vi.fn(),
      onSave: vi.fn(),
    }
    const rendered = render(
      <CodeMirrorBuffer {...props} markdownMode="render" projectEntries={[]} />,
    )

    expect(rendered.container.querySelector(".cm-md-heading-1")).toBeTruthy()
    expect(rendered.container.querySelector(".cm-md-strong")).toBeTruthy()
    expect(rendered.container.querySelector(".cm-md-list")).toBeTruthy()
    expect(rendered.container.querySelector(".cm-md-table")).toBeTruthy()
    expect(rendered.container.querySelectorAll(".cm-md-source-mark").length).toBeGreaterThan(4)
    const editor = findEditor(rendered.container)
    expect(editor.state.doc.toString()).toBe(markdown)

    rendered.rerender(<CodeMirrorBuffer {...props} markdownMode="source" projectEntries={[]} />)
    expect(rendered.container.querySelector(".cm-md-heading-1")).toBeNull()
    expect(rendered.container.querySelector(".cm-md-source-mark")).toBeNull()
    expect(editor.state.doc.toString()).toBe(markdown)
  })

  test("formats the current selection through the floating toolbar", () => {
    const onChange = vi.fn()
    const rendered = render(
      <CodeMirrorBuffer
        relPath="notes.md"
        initialDoc="important result"
        onChange={onChange}
        onSave={vi.fn()}
        markdownMode="render"
        projectEntries={[]}
      />,
    )
    const editor = findEditor(rendered.container)

    act(() => editor.dispatch({ selection: { anchor: 0, head: 9 } }))
    fireEvent.mouseDown(screen.getByRole("toolbar", { name: "Markdown formatting" }))
    fireEvent.click(screen.getByRole("button", { name: "Bold" }))

    expect(onChange).toHaveBeenLastCalledWith("**important** result")
  })

  test("inserts blocks and starts links with @ from the slash menu", () => {
    const onChange = vi.fn()
    const rendered = render(
      <CodeMirrorBuffer
        relPath="notes.md"
        initialDoc="/"
        onChange={onChange}
        onSave={vi.fn()}
        markdownMode="render"
        projectEntries={[]}
      />,
    )
    const editor = findEditor(rendered.container)

    act(() => editor.dispatch({ selection: { anchor: 1 } }))
    expect(screen.getByRole("listbox", { name: "Markdown blocks" })).toBeTruthy()
    fireEvent.mouseDown(screen.getByRole("option", { name: "Table" }))
    expect(onChange).toHaveBeenLastCalledWith(
      "| Column 1 | Column 2 |\n| --- | --- |\n| Value 1 | Value 2 |",
    )

    act(() => {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: "/" },
        selection: { anchor: 1 },
      })
    })
    expect(screen.queryByText("results.csv")).toBeNull()
    fireEvent.mouseDown(screen.getByRole("option", { name: "Link" }))
    expect(onChange).toHaveBeenLastCalledWith("@")
  })

  test("navigates and chooses slash commands without leaving the keyboard", async () => {
    const onChange = vi.fn()
    const rendered = render(
      <CodeMirrorBuffer
        relPath="notes.md"
        initialDoc="/"
        onChange={onChange}
        onSave={vi.fn()}
        markdownMode="render"
        projectEntries={[]}
      />,
    )
    const editor = findEditor(rendered.container)
    act(() => editor.dispatch({ selection: { anchor: 1 } }))

    expect(screen.getByRole("option", { name: "Header" }).getAttribute("aria-selected")).toBe(
      "true",
    )
    fireEvent.keyDown(editor.contentDOM, { key: "Enter" })
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Heading 1" }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    )
    fireEvent.keyDown(editor.contentDOM, { key: "ArrowUp" })
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Heading 3" }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    )
    fireEvent.keyDown(editor.contentDOM, { key: "Enter" })

    expect(onChange).toHaveBeenLastCalledWith("### ")
    expect(screen.queryByRole("listbox", { name: "Markdown blocks" })).toBeNull()
  })

  test("continues Markdown list and task-list items on Enter", () => {
    const onChange = vi.fn()
    const rendered = render(
      <CodeMirrorBuffer
        relPath="notes.md"
        initialDoc="- first"
        onChange={onChange}
        onSave={vi.fn()}
        markdownMode="render"
      />,
    )
    const editor = findEditor(rendered.container)
    act(() => editor.dispatch({ selection: { anchor: editor.state.doc.length } }))
    fireEvent.keyDown(editor.contentDOM, { key: "Enter" })
    expect(onChange).toHaveBeenLastCalledWith("- first\n- ")

    act(() => {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: "- [x] done" },
        selection: { anchor: "- [x] done".length },
      })
    })
    fireEvent.keyDown(editor.contentDOM, { key: "Enter" })
    expect(onChange).toHaveBeenLastCalledWith("- [x] done\n- [ ] ")
  })
})
