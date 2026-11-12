import { describe, expect, test } from "vitest"
import {
  bindingFromEvent,
  eventMatchesShortcut,
  findShortcutConflict,
  formatBinding,
  matchesBinding,
  SHORTCUTS,
} from "./shortcuts"

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

describe("dictation shortcut", () => {
  test("defaults to a rebindable Cmd+D; split right has no default and never conflicts", () => {
    expect(SHORTCUTS.find((shortcut) => shortcut.id === "dictation-toggle")).toMatchObject({
      defaultBinding: "Mod+d",
      editable: true,
    })
    expect(findShortcutConflict("dictation-toggle", "Mod+d", defaults)).toBeNull()
    expect(defaults("split-right")).toBe("")
    expect(findShortcutConflict("split-down", "", defaults)).toBeNull()
    expect(formatBinding("")).toBe("Not set")
  })

  test("matches macOS Option+D by physical key, although the key event reports ∂", () => {
    const optionD = new KeyboardEvent("keydown", { key: "∂", code: "KeyD", altKey: true })
    expect(matchesBinding(optionD, "Alt+d")).toBe(true)
    expect(matchesBinding(optionD, "Mod+d")).toBe(false)
    const plainD = new KeyboardEvent("keydown", { key: "d", code: "KeyD" })
    expect(matchesBinding(plainD, "Alt+d")).toBe(false)
  })

  test("records Option+letter as the letter, not the macOS dead-key character", () => {
    const optionD = new KeyboardEvent("keydown", { key: "∂", code: "KeyD", altKey: true })
    expect(bindingFromEvent(optionD)).toBe("Alt+d")
    const optionShift7 = new KeyboardEvent("keydown", {
      key: "‡",
      code: "Digit7",
      altKey: true,
      shiftKey: true,
    })
    expect(bindingFromEvent(optionShift7)).toBe("Shift+Alt+7")
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
