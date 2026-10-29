import { describe, expect, test } from "vitest"
import { findShortcutConflict, formatBinding, SHORTCUTS } from "./shortcuts"

const defaults = (id: string): string =>
  SHORTCUTS.find((shortcut) => shortcut.id === id)?.defaultBinding ?? ""

describe("shortcut conflicts", () => {
  test("keeps quick-open labeled as project file search on Mod+f", () => {
    expect(SHORTCUTS.find((shortcut) => shortcut.id === "quick-open")).toMatchObject({
      label: "Quick open file",
      description: "Search and open a file in the project view",
      defaultBinding: "Mod+f",
    })
  })

  test("finds the existing action deterministically and excludes the action being rebound", () => {
    expect(findShortcutConflict("command-palette", "Mod+f", defaults)?.id).toBe("quick-open")
    expect(findShortcutConflict("quick-open", "Mod+f", defaults)).toBeNull()
    expect(findShortcutConflict("command-palette", "Mod+s", defaults)?.id).toBe("save-file")
  })
})

describe("formatBinding", () => {
  test("shows modifiers in the macOS order before the key", () => {
    expect(formatBinding("Mod+Shift+p")).toBe("⇧⌘P")
    expect(formatBinding("Mod+Alt+Shift+k")).toBe("⌥⇧⌘K")
    expect(formatBinding("Mod+,")).toBe("⌘,")
  })
})
