import type { EditorSettings } from "@skipper/local-db"
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
  typeChecker: "ty",
  formatOnSave: false,
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
    render(<EditorSettingsMenu settings={{ ...SETTINGS, vim: true, typeChecker: "pyrefly" }} />)
    fireEvent.click(screen.getByTestId("editor-settings"))

    expect(screen.getByTestId("editor-settings-vim").getAttribute("data-checked")).toBe("true")
    expect(screen.getByTestId("editor-settings-autosave").getAttribute("data-checked")).toBe(
      "false",
    )
    expect(screen.getByTestId("editor-settings-checker-pyrefly").getAttribute("data-active")).toBe(
      "true",
    )
    expect(screen.getByTestId("editor-settings-checker-ty").getAttribute("data-active")).toBe(
      "false",
    )
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

  test("selecting a type checker patches typeChecker", () => {
    const onChange = vi.fn()
    render(<EditorSettingsMenu settings={SETTINGS} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("editor-settings"))

    fireEvent.click(screen.getByTestId("editor-settings-checker-pyrefly"))
    expect(onChange).toHaveBeenCalledWith({ typeChecker: "pyrefly" })
  })
})
