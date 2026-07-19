import { render } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { CodeMirrorBuffer } from "./CodeMirrorBuffer"

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
