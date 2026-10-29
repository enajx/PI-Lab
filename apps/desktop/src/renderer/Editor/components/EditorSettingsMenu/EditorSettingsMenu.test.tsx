import type { EditorSettings } from "@pi-lab/local-db/editor-settings"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { EditorSettingsMenu } from "./EditorSettingsMenu"

/**
 * Component test for the in-toolbar editor-settings popover (spec: TODO
 * "Built-in editor" — "Editor settings group"). The menu is self-contained (no
 * tRPC), so these assert purely on the DOM: the gear opens the menu, each toggle
 * reflects the current setting, and a click round-trips a single-field patch
 * through `onChange` (wired to `settings.updateEditor` in the app).
 */

const SETTINGS: EditorSettings = {
  autosave: false,
  vim: false,
  diagnosticsEnabled: false,
  typeChecker: "ty",
  formatOnSave: false,
  editorTheme: "default",
  customEditorThemes: [],
  pythonRunDestination: "central",
  latexProvider: "bundled",
  showHiddenFiles: true,
  confirmFileDelete: true,
}

describe("EditorSettingsMenu", () => {
  test("the gear toggles the menu open and closed", () => {
    render(<EditorSettingsMenu settings={SETTINGS} />)
    expect(screen.queryByTestId("editor-settings-menu")).toBeNull()

    fireEvent.click(screen.getByTestId("editor-settings"))
    expect(screen.getByTestId("editor-settings-menu")).toBeTruthy()

    fireEvent.click(screen.getByTestId("editor-settings"))
    expect(screen.queryByTestId("editor-settings-menu")).toBeNull()
  })

  test("toggles reflect the current settings", () => {
    render(<EditorSettingsMenu settings={{ ...SETTINGS, vim: true }} />)
    fireEvent.click(screen.getByTestId("editor-settings"))

    expect(screen.getByTestId("editor-settings-vim").getAttribute("data-checked")).toBe("true")
    expect(screen.getByTestId("editor-settings-autosave").getAttribute("data-checked")).toBe(
      "false",
    )
  })

  test("the type checker is not offered here (it lives in Settings → Editor)", () => {
    render(<EditorSettingsMenu settings={SETTINGS} />)
    fireEvent.click(screen.getByTestId("editor-settings"))

    expect(screen.queryByTestId("editor-settings-checker-ty")).toBeNull()
    expect(screen.queryByTestId("editor-settings-checker-pyrefly")).toBeNull()
  })

  test("puts toggles first and exposes a single Advanced settings link", () => {
    render(<EditorSettingsMenu settings={SETTINGS} />)
    fireEvent.click(screen.getByTestId("editor-settings"))

    const menu = screen.getByTestId("editor-settings-menu")
    const rows = Array.from(menu.querySelectorAll("button, select"))
    expect(rows.slice(0, 4).map((row) => row.getAttribute("data-testid"))).toEqual([
      "editor-settings-autosave",
      "editor-settings-vim",
      "editor-settings-diagnostics",
      "editor-settings-format-on-save",
    ])
    expect(screen.getAllByRole("separator")).toHaveLength(3)
    expect(screen.getByLabelText("Terminal location")).toBeTruthy()
    expect(screen.queryByText("Typography…")).toBeNull()

    fireEvent.click(screen.getByTestId("editor-advanced-settings-link"))
    expect(window.location.hash).toBe("#/settings?section=editor&advanced=editor-typography")
    expect(screen.queryByTestId("editor-settings-font-family")).toBeNull()
    expect(screen.queryByTestId("editor-settings-font-size")).toBeNull()
  })

  test("toggling autosave patches just that field", () => {
    const onChange = vi.fn()
    render(<EditorSettingsMenu settings={SETTINGS} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("editor-settings"))

    fireEvent.click(screen.getByTestId("editor-settings-autosave"))
    expect(onChange).toHaveBeenCalledWith({ autosave: true })
  })

  test("toggling vim and format-on-save each patch their own field", () => {
    const onChange = vi.fn()
    render(<EditorSettingsMenu settings={SETTINGS} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("editor-settings"))

    fireEvent.click(screen.getByTestId("editor-settings-vim"))
    fireEvent.click(screen.getByTestId("editor-settings-format-on-save"))
    expect(onChange).toHaveBeenNthCalledWith(1, { vim: true })
    expect(onChange).toHaveBeenNthCalledWith(2, { formatOnSave: true })
  })

  test("toggling diagnostics patches the persisted diagnostics setting", () => {
    const onChange = vi.fn()
    render(<EditorSettingsMenu settings={SETTINGS} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("editor-settings"))

    const diagnostics = screen.getByTestId("editor-settings-diagnostics")
    expect(diagnostics.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(diagnostics)

    expect(onChange).toHaveBeenCalledWith({ diagnosticsEnabled: true })
  })

  test("selects built-in and imported themes while a file is open", () => {
    const onChange = vi.fn()
    const custom = {
      id: "custom:ocean:abc",
      name: "Ocean",
      mode: "dark" as const,
      colors: { background: "#102030", foreground: "#ddeeff" },
      tokenColors: [],
    }
    render(
      <EditorSettingsMenu
        settings={{ ...SETTINGS, customEditorThemes: [custom] }}
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByTestId("editor-settings"))
    const select = screen.getByTestId("editor-settings-theme")
    expect(select.textContent).toContain("Ocean (Dark)")
    fireEvent.change(select, { target: { value: custom.id } })
    expect(onChange).toHaveBeenCalledWith({ editorTheme: custom.id })
  })

  test("changes the persisted Terminal location", () => {
    const onChange = vi.fn()
    render(<EditorSettingsMenu settings={SETTINGS} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("editor-settings"))
    fireEvent.change(screen.getByTestId("editor-settings-run-destination"), {
      target: { value: "below-editor" },
    })
    expect(onChange).toHaveBeenCalledWith({ pythonRunDestination: "below-editor" })
  })
})
