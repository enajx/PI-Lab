import { describe, expect, test } from "vitest"
import { createHeadlessRenderedTerminal } from "./renderedTerminal"

function write(terminal: ReturnType<typeof createHeadlessRenderedTerminal>, chunk: string) {
  return new Promise<void>((resolve) => terminal.write(chunk, resolve))
}

describe("headless rendered terminal", () => {
  test("classifies the screen users see after ANSI/TUI redraws, not stale raw output", async () => {
    const terminal = createHeadlessRenderedTerminal(80, 8)
    await write(terminal, "Working…")
    await write(terminal, "\r\u001b[2KAllow this command? [y/N]")

    expect(terminal.screen()).toContain("Allow this command? [y/N]")
    expect(terminal.screen()).not.toContain("Working")
    terminal.dispose()
  })

  test("tracks renderer-compatible resizes", async () => {
    const terminal = createHeadlessRenderedTerminal(12, 4)
    terminal.resize(6, 4)
    await write(terminal, "abcdefgh")

    expect(terminal.screen()).toContain("abcdef")
    expect(terminal.screen()).toContain("gh")
    terminal.dispose()
  })

  test("distinguishes newline-terminated output from the live cursor prompt", async () => {
    const terminal = createHeadlessRenderedTerminal(80, 8)
    await write(terminal, "➜ prompt-shaped output\r\n")
    expect(terminal.screen()).toContain("➜ prompt-shaped output")
    expect(terminal.cursorLine()).toBe("")

    await write(terminal, "➜ repo")
    expect(terminal.cursorLine()).toBe("➜ repo")
    terminal.dispose()
  })
})
