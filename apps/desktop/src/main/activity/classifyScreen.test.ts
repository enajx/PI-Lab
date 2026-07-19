import { describe, expect, test } from "vitest"
import { classifyRenderedAgentScreen } from "./classifyScreen"

const CLAUDE_PERMISSION_SCREEN = `
╭──────────────────────────────────────────────────────────────────────╮
│ Bash command                                                        │
│ npm test                                                            │
╰──────────────────────────────────────────────────────────────────────╯
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again
  3. No
`

const CODEX_PERMISSION_SCREEN = `
Would you like to run the following command?

$ git status

› 1. Yes, proceed
  2. No, and tell Codex what to do differently
`

const CLAUDE_QUESTION_SCREEN = `
Question
How should Claude update the existing migration?

❯ 1. Generate a new migration
  2. Rework the current migration
`

const CODEX_QUESTION_SCREEN = `
› What should I use for the notification sound?
  1. Glass
  2. Silent
`

describe("classifyRenderedAgentScreen", () => {
  test.each([
    ["Claude", CLAUDE_PERMISSION_SCREEN],
    ["Codex", CODEX_PERMISSION_SCREEN],
  ])("recognizes a rendered %s permission screen", (_agent, screen) => {
    expect(classifyRenderedAgentScreen(screen).kind).toBe("permission")
  })

  test.each([
    ["Claude", CLAUDE_QUESTION_SCREEN],
    ["Codex", CODEX_QUESTION_SCREEN],
  ])("recognizes a rendered %s question screen", (_agent, screen) => {
    expect(classifyRenderedAgentScreen(screen).kind).toBe("question")
  })

  test.each([
    ["Claude", '\u001b[32mClaude Code\u001b[0m\n\n  Welcome back\n\n❯ Try "fix the failing tests"'],
    ["Codex", "OpenAI Codex (v1.2.3)\nmodel: gpt-5\n\n› Ask Codex to do anything"],
  ])("recognizes a rendered %s normal input prompt", (_agent, screen) => {
    expect(classifyRenderedAgentScreen(screen).kind).toBe("normal-prompt")
  })

  test("a current prompt wins over permission text retained in visible scrollback", () => {
    expect(
      classifyRenderedAgentScreen(`
Would you like to run the following command?
$ bun test
› 1. Yes, proceed

Tests passed.
› Ask Codex to do anything
gpt-5 · 97% left
`),
    ).toMatchObject({ kind: "normal-prompt" })
  })

  test("recognizes a fatal screen and keeps a useful failure description", () => {
    expect(classifyRenderedAgentScreen("Fatal error: model provider disconnected")).toEqual({
      kind: "fatal",
      fingerprint: "Fatal error: model provider disconnected",
      message: "Fatal error: model provider disconnected",
    })
  })

  test("treats substantive rendered text as qualifying agent output", () => {
    expect(
      classifyRenderedAgentScreen(
        "I inspected the repository and found three callers.\nNow I am updating the shared type.",
      ).kind,
    ).toBe("agent-output")
  })

  test.each([
    "",
    "   ",
    "⠋",
    "Thinking…",
    "esc to interrupt",
  ])("does not qualify transient or empty UI as agent output: %j", (screen) => {
    expect(classifyRenderedAgentScreen(screen).kind).toBe("unknown")
  })
})
