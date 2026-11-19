// Menu reading and key mapping tests. The fixtures in __fixtures__/menus are
// screens captured from real Claude Code 2.1 sessions (terminal.screenText,
// 80 columns), cleaned of personal paths and names with same-length text so
// line wrapping is unchanged. codex-trust is a captured Codex CLI screen.

import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { type MenuAction, menuKeys, parseTerminalMenu } from "./terminalMenu"

const COLS = 80
const DOWN = "\u001b[B"
const UP = "\u001b[A"

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/menus/${name}.txt`, import.meta.url), "utf8")
}

function menuOf(name: string) {
  const parsed = parseTerminalMenu(fixture(name), COLS)
  if (parsed === null) throw new Error(`no menu read from ${name}`)
  return parsed
}

/** The options as [key, label, cursor, checked, freeText] rows, for compact expectations. */
function rows(name: string) {
  return menuOf(name).menu.options.map((option) => [
    option.key,
    option.label,
    option.cursor,
    option.checked,
    option.freeText,
  ])
}

describe("parseTerminalMenu", () => {
  test("reads a Claude Code single-choice question", () => {
    const { menu } = menuOf("claude-single-choice")
    expect(menu.question).toBe("Which colour do you prefer?")
    expect(menu.multiSelect).toBe(false)
    expect(menu.tabs).toBeNull()
    expect(rows("claude-single-choice")).toEqual([
      ["1", "Blue", true, null, false],
      ["2", "Green", false, null, false],
      ["3", "Red", false, null, false],
      ["4", "Purple", false, null, false],
      ["5", "Type something.", false, null, true],
      ["6", "Chat about this", false, null, false],
    ])
    expect(menu.options[0]?.detail).toBe("Cool, calm blue")
    expect(menu.options[5]?.detail).toBeNull()
  })

  test("reads a Claude Code multi-select question with its ticks", () => {
    const { menu } = menuOf("claude-multi-select")
    expect(menu.question).toBe("Which colours do you like? Tick all that apply.")
    expect(menu.multiSelect).toBe(true)
    expect(menu.tabs).toEqual([{ label: "Colours", answered: false }])
    expect(rows("claude-multi-select")).toEqual([
      ["1", "Red", true, false, false],
      ["2", "Blue", false, false, false],
      ["3", "Green", false, false, false],
      ["4", "Yellow", false, false, false],
      ["5", "Type something", false, false, true],
      ["6", "Chat about this", false, null, false],
    ])
  })

  test("reads ticked options and a cursor on the Submit row", () => {
    expect(rows("claude-form-multi-ticked").map((row) => row[3])).toEqual([
      true,
      true,
      false,
      false,
      false,
      null,
    ])
    // The cursor is on Submit (no option has it); option 5 holds typed text.
    expect(rows("claude-multi-submit-row")).toEqual([
      ["1", "Red", false, false, false],
      ["2", "Blue", false, true, false],
      ["3", "Green", false, false, false],
      ["4", "Yellow/Orange", false, false, false],
      ["5", "Pink", false, true, true],
      ["6", "Chat about this", false, null, false],
    ])
  })

  test("reads the question showing in a tabbed plan-mode form, with the tabs", () => {
    const { menu } = menuOf("claude-form-first")
    expect(menu.question).toBe("Which frontend framework do you want to use?")
    expect(menu.multiSelect).toBe(false)
    expect(menu.tabs).toEqual([
      { label: "Framework", answered: false },
      { label: "App type", answered: false },
      { label: "Styling", answered: false },
      { label: "Extras", answered: false },
    ])
    expect(menu.options.map((option) => option.label)).toEqual([
      "React",
      "Vue",
      "Svelte",
      "Plain HTML/JS",
      "Type something.",
      "Chat about this",
    ])
  })

  test("reads a question drawn with a quote bar, without the bar", () => {
    const { menu } = menuOf("claude-form-quoted-question")
    expect(menu.question).toBe(
      "The repo has one metrics CSV per run (overwritten each time, no hyperparameters saved). How should the dashboard handle multiple runs?",
    )
    expect(menu.tabs).toEqual([
      { label: "Run storage", answered: false },
      { label: "Scope", answered: false },
    ])
    expect(menu.options[1]?.detail).toBe(
      "No train.py changes; dashboard picks any metrics CSV files, labelled by filename",
    )
  })

  test("reads the review step of a form, with the answers as the question", () => {
    const { menu } = menuOf("claude-form-review")
    expect(menu.question).toBe(
      [
        "Review your answers",
        "● Which frontend framework do you want to use?",
        "→ Vue",
        "● What kind of app is this frontend for?",
        "→ Dashboard",
        "● How should it be styled?",
        "→ Tailwind CSS",
        "● Which extras should the plan cover?",
        "→ Dark mode, Routing",
      ].join("\n"),
    )
    expect(menu.tabs?.every((tab) => tab.answered)).toBe(true)
    expect(rows("claude-form-review")).toEqual([
      ["1", "Submit answers", true, null, false],
      ["2", "Cancel", false, null, false],
    ])
    expect(menuOf("claude-multi-review").menu.options.map((option) => option.label)).toEqual([
      "Submit answers",
      "Cancel",
    ])
  })

  test("reads permission prompts, joining labels that wrapped", () => {
    const create = menuOf("claude-permission-create").menu
    expect(create.question).toBe("Do you want to create hello.txt?")
    expect(rows("claude-permission-create")).toEqual([
      ["1", "Yes", true, null, false],
      [
        "2",
        "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)",
        false,
        null,
        false,
      ],
      ["3", "No", false, null, false],
    ])
    const bash = menuOf("claude-permission-bash").menu
    expect(bash.question).toBe("Do you want to proceed?")
    expect(bash.options.map((option) => option.label)).toEqual([
      "Yes",
      "Yes, and always allow access to /private/var/folders/xx/000000000000000000000000000000/T/pi-lab-mobile-test/data/worktrees/00000000-0000-4000-8000-000000000000/agent-mwnka2tj from this project",
      "Yes, and switch to auto mode · auto mode handles these prompts for you",
      "No",
    ])
  })

  test("reads the plan approval prompt, whose third option takes typed text", () => {
    const { menu } = menuOf("claude-plan-approval")
    expect(menu.question).toBe(
      "Claude has written up a plan and is ready to execute. Would you like to proceed?",
    )
    expect(rows("claude-plan-approval")).toEqual([
      [
        "1",
        "Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session",
        true,
        null,
        false,
      ],
      ["2", "Yes, manually approve edits", false, null, false],
      ["3", "Tell Claude what to change", false, null, true],
    ])
    expect(menu.options[2]?.detail).toBe("shift+tab to approve with this feedback")
  })

  test("reads the folder trust prompt, whose options have no numbers", () => {
    const { menu } = menuOf("claude-trust")
    expect(menu.question).toMatch(/^Quick safety check: Is this a project you created/)
    expect(rows("claude-trust")).toEqual([
      ["1", "No, exit", true, null, false],
      ["2", "Yes, I trust this folder", false, null, false],
    ])
  })

  test("the menu id stays while ticks and the cursor move, and changes with the question", () => {
    const first = menuOf("claude-multi-select").menu.id
    const moved = parseTerminalMenu(
      fixture("claude-multi-select")
        .replace("❯ 1. [ ] Red", "  1. [ ] Red")
        .replace("  2. [ ] Blue", "❯ 2. [✔] Blue"),
      COLS,
    )
    expect(moved?.menu.id).toBe(first)
    expect(moved?.menu.options[1]).toMatchObject({ cursor: true, checked: true })
    const other = parseTerminalMenu(
      fixture("claude-multi-select").replace("Which colours", "What colours"),
      COLS,
    )
    expect(other?.menu.id).not.toBe(first)
  })

  test.each([
    ["no menu: Claude's normal input box", fixture("claude-multi-review").split("────")[0] ?? ""],
    [
      "an unknown footer",
      fixture("claude-single-choice").replace("Enter to select", "Press to pick"),
    ],
    ["a Codex screen (not covered)", fixture("codex-trust")],
    ["a menu above other output", `${fixture("claude-single-choice")}\nlater output line`],
    [
      "a line in the option list that is no option",
      fixture("claude-single-choice").replace("     Fresh, natural green", "stray"),
    ],
    ["empty", ""],
  ])("gives no menu for %s", (_name, screen) => {
    expect(parseTerminalMenu(screen, COLS)).toBeNull()
  })
})

describe("menuKeys", () => {
  function keys(name: string, action: MenuAction) {
    return menuKeys(menuOf(name), action)
  }

  test("a numbered single choice is its number key and finishes the menu", () => {
    expect(keys("claude-single-choice", { kind: "choose", option: "3" })).toEqual({
      writes: ["3"],
      finishes: true,
    })
    expect(keys("claude-permission-bash", { kind: "choose", option: "1" })).toEqual({
      writes: ["1"],
      finishes: true,
    })
  })

  test("a pick in a form moves to the next question and does not finish it; the review does", () => {
    expect(keys("claude-form-first", { kind: "choose", option: "2" })).toEqual({
      writes: ["2"],
      finishes: false,
    })
    expect(keys("claude-form-review", { kind: "choose", option: "1" })).toEqual({
      writes: ["1"],
      finishes: true,
    })
  })

  test("the trust prompt moves with arrows and confirms with Enter", () => {
    expect(keys("claude-trust", { kind: "choose", option: "2" })).toEqual({
      writes: [DOWN, "\r"],
      finishes: true,
    })
    expect(keys("claude-trust", { kind: "choose", option: "1" })).toEqual({
      writes: ["\r"],
      finishes: true,
    })
  })

  test("typed text for a single choice: the number, the text, Enter; new lines become spaces", () => {
    expect(
      keys("claude-single-choice", { kind: "text", option: "5", text: "Mango\nor kiwi" }),
    ).toEqual({ writes: ["5", "Mango or kiwi", "\r"], finishes: true })
  })

  test("multi-select: a number ticks, Submit is reached with arrows, typed text goes to its row", () => {
    expect(keys("claude-multi-select", { kind: "choose", option: "2" })).toEqual({
      writes: ["2"],
      finishes: false,
    })
    expect(keys("claude-multi-select", { kind: "submit" })).toEqual({
      writes: [DOWN, DOWN, DOWN, DOWN, DOWN, "\r"],
      finishes: false,
    })
    expect(keys("claude-multi-select", { kind: "text", option: "5", text: "Teal" })).toEqual({
      writes: [DOWN, DOWN, DOWN, DOWN, "Teal"],
      finishes: false,
    })
    expect(keys("claude-multi-submit-row", { kind: "submit" })).toEqual({
      writes: ["\r"],
      finishes: false,
    })
    expect(keys("claude-multi-submit-row", { kind: "text", option: "5", text: "Rose" })).toEqual({
      writes: [UP, "Rose"],
      finishes: false,
    })
  })

  test.each([
    ["an option not on the menu", "claude-single-choice", { kind: "choose", option: "9" }],
    ["Submit on a single choice", "claude-single-choice", { kind: "submit" }],
    [
      "text for an option that takes none",
      "claude-single-choice",
      { kind: "text", option: "1", text: "x" },
    ],
    ["empty text", "claude-single-choice", { kind: "text", option: "5", text: "  " }],
  ] as const)("refuses %s", (_name, name, action) => {
    expect(keys(name, action)).toBeNull()
  })
})
