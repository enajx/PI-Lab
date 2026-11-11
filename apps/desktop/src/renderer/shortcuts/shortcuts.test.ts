import { describe, expect, test } from "vitest"
import { eventMatchesShortcut, findShortcutConflict, formatBinding, SHORTCUTS } from "./shortcuts"

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

describe("agent and dashboard shortcuts", () => {
  const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent("keydown", init)

  test("Mod+Escape goes to the Dashboard with ⌘ or Ctrl", () => {
    expect(eventMatchesShortcut(key({ key: "Escape", metaKey: true }), "go-to-dashboard")).toBe(
      true,
    )
    expect(eventMatchesShortcut(key({ key: "Escape", ctrlKey: true }), "go-to-dashboard")).toBe(
      true,
    )
    expect(eventMatchesShortcut(key({ key: "Escape" }), "go-to-dashboard")).toBe(false)
  })

  test("Option+Tab and Option+Shift+Tab match only their own action", () => {
    const optionTab = key({ key: "Tab", altKey: true })
    const optionShiftTab = key({ key: "Tab", altKey: true, shiftKey: true })
    expect(eventMatchesShortcut(optionTab, "next-waiting-agent")).toBe(true)
    expect(eventMatchesShortcut(optionTab, "next-waiting-agent-in-project")).toBe(false)
    expect(eventMatchesShortcut(optionShiftTab, "next-waiting-agent-in-project")).toBe(true)
    expect(eventMatchesShortcut(optionShiftTab, "next-waiting-agent")).toBe(false)
    expect(eventMatchesShortcut(key({ key: "Tab" }), "next-waiting-agent")).toBe(false)
  })

  test("a rebind in Settings storage replaces the default", () => {
    window.localStorage.setItem(
      "pi-lab.shortcuts",
      JSON.stringify({ "next-waiting-agent": "Mod+j" }),
    )
    expect(eventMatchesShortcut(key({ key: "j", metaKey: true }), "next-waiting-agent")).toBe(true)
    expect(eventMatchesShortcut(key({ key: "Tab", altKey: true }), "next-waiting-agent")).toBe(
      false,
    )
    window.localStorage.clear()
  })
})
