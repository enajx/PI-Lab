import { describe, expect, test } from "vitest"
import { mapTerminalKeyEvent, type TerminalInputKind } from "./terminalKeyMapping"

function keyEvent(
  key: string,
  modifiers: Partial<{
    altKey: boolean
    ctrlKey: boolean
    metaKey: boolean
    shiftKey: boolean
    isComposing: boolean
    type: string
  }>,
) {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    type: "keydown",
    ...modifiers,
  }
}

describe("mapTerminalKeyEvent", () => {
  test("maps macOS Option+Backspace to readline/zle previous-word delete", () => {
    expect(
      mapTerminalKeyEvent(keyEvent("Backspace", { altKey: true }), {
        platform: "darwin",
        inputKind: "terminal",
      }),
    ).toBe("\u001b\u007f")
  })

  test("maps macOS Command+Backspace to readline/zle line-start delete", () => {
    expect(
      mapTerminalKeyEvent(keyEvent("Backspace", { metaKey: true }), {
        platform: "darwin",
        inputKind: "terminal",
      }),
    ).toBe("\u0015")
  })

  test.each([
    ["agent", "\u001b[13;2u"],
    ["terminal", "\u0016\n"],
  ] satisfies Array<
    [TerminalInputKind, string]
  >)("maps macOS Shift+Enter for %s input without submitting", (inputKind, expected) => {
    expect(
      mapTerminalKeyEvent(keyEvent("Enter", { shiftKey: true }), {
        platform: "darwin",
        inputKind,
      }),
    ).toBe(expected)
  })

  test.each([
    { altKey: true },
    { metaKey: true },
  ])("leaves macOS forward Delete unchanged for xterm", (modifiers) => {
    expect(
      mapTerminalKeyEvent(keyEvent("Delete", modifiers), {
        platform: "darwin",
        inputKind: "terminal",
      }),
    ).toBeNull()
  })

  test("leaves ordinary, non-macOS, shortcut, and IME events to xterm", () => {
    expect(
      mapTerminalKeyEvent(keyEvent("Enter", {}), {
        platform: "darwin",
        inputKind: "terminal",
      }),
    ).toBeNull()
    expect(
      mapTerminalKeyEvent(keyEvent("Enter", { shiftKey: true }), {
        platform: "linux",
        inputKind: "terminal",
      }),
    ).toBeNull()
    expect(
      mapTerminalKeyEvent(keyEvent("Backspace", { altKey: true }), {
        platform: "linux",
        inputKind: "terminal",
      }),
    ).toBeNull()
    expect(
      mapTerminalKeyEvent(keyEvent("Delete", { metaKey: true }), {
        platform: "win32",
        inputKind: "terminal",
      }),
    ).toBeNull()
    expect(
      mapTerminalKeyEvent(keyEvent("c", { metaKey: true }), {
        platform: "darwin",
        inputKind: "terminal",
      }),
    ).toBeNull()
    expect(
      mapTerminalKeyEvent(keyEvent("Backspace", { altKey: true, metaKey: true }), {
        platform: "darwin",
        inputKind: "terminal",
      }),
    ).toBeNull()
    expect(
      mapTerminalKeyEvent(keyEvent("Enter", { shiftKey: true, isComposing: true }), {
        platform: "darwin",
        inputKind: "agent",
      }),
    ).toBeNull()
    expect(
      mapTerminalKeyEvent(keyEvent("Enter", { shiftKey: true, type: "keyup" }), {
        platform: "darwin",
        inputKind: "agent",
      }),
    ).toBeNull()
  })
})
