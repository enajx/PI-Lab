import { createHash } from "node:crypto"
import type { MenuAction, TerminalMenu } from "../../shared/clientApi"

export type { MenuAction } from "../../shared/clientApi"

/**
 * Reads the menu a Claude Code agent shows at the bottom of its screen
 * (permission prompts, the folder trust prompt, AskUserQuestion questions,
 * multi-select questions, tabbed plan-mode forms and their review step, the
 * plan approval prompt) and maps a choice to the keys Claude Code accepts.
 * Any screen whose shape is not known exactly gives no menu: a client then
 * shows the plain screen, never buttons that could press the wrong thing.
 *
 * Keys found in real Claude Code 2.1 sessions:
 * - A numbered option is picked by its number key at once (no Enter). In a
 *   multi-select question the number ticks or unticks it, the cursor stays.
 * - In a tabbed form a pick moves on to the next question; the last step
 *   ("Review your answers") is a numbered menu whose "Submit answers" ends it.
 * - A multi-select question is confirmed from its "Submit" row (arrows, then
 *   Enter), which opens the review step.
 * - A free-text option ("Type something.") takes text while the cursor is on
 *   it: in a single choice its number moves the cursor there, then the text
 *   and Enter send it; in a multi-select question the arrows move there and
 *   the typed text ticks it.
 * - The trust prompt has no numbers: arrows, then Enter.
 */

/** A menu read from the screen, with what the key mapping needs. */
export interface ParsedMenu {
  menu: TerminalMenu
  /** Options picked by number keys (false: by arrows and Enter). */
  numbered: boolean
  /** The rows the arrow keys move over, top to bottom: option keys and the multi-select Submit row. */
  rows: Array<string | typeof SUBMIT_ROW>
  /** Index in `rows` of the row the cursor is on. */
  cursorRow: number
  /** The review step of a tabbed form. */
  review: boolean
}

/** The keys for one choice, written one at a time, and whether they end the menu. */
export interface MenuKeys {
  writes: string[]
  finishes: boolean
}

const SUBMIT_ROW = Symbol("submit")
const CURSOR = "❯"
const DOWN = "\u001b[B"
const UP = "\u001b[A"

/** A divider line (box borders and rules Claude Code draws). */
const RULE = /^\s*[─━═╌┄┈▔]{10,}\s*$/
/** Footer of AskUserQuestion questions and plan-mode forms. */
const QUESTION_FOOTER = /^Enter to select · .*to navigate\b/
const FOOTERS = [
  QUESTION_FOOTER,
  // Permission prompts.
  /^Esc to cancel\b/,
  // The folder trust prompt (options without numbers).
  /^Enter to confirm · Esc to cancel$/,
  // The plan approval prompt.
  /^ctrl\+g to edit in nano · /,
]
const TRUST_FOOTER = FOOTERS[2]
const REVIEW_TITLE = "Review your answers"
/** Labels of options that take typed text before any text is typed. */
const FREE_TEXT_LABELS = new Set([
  "Type something.",
  "Type something",
  "Tell Claude what to change",
])
const NUMBERED_OPTION = /^(\s*)(?:❯\s)?\s*(\d+)\.\s(.*)$/
const UNNUMBERED_OPTION = /^(\s*)(?:❯\s)?\s*(\S.*)$/
const TICK_BOX = /^\[( |✔)\] /
const SUBMIT_LINE = /^(?:❯\s+)?Submit$/
const TAB_BAR = /^←\s+(.*?)\s+→$/
const MAX_OPTIONS = 9

interface OptionDraft {
  key: string
  label: string
  detail: string | null
  cursor: boolean
  checked: boolean | null
  freeText: boolean
  /** Column where the label starts; continuation lines start at or after it. */
  labelCol: number
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/**
 * True when `next` continues `previous` because its first word did not fit on
 * the line. Claude Code wraps its menus one column before the last.
 */
function wrapped(previous: string, next: string, cols: number): boolean {
  const firstWord = next.trim().split(" ")[0] ?? ""
  return previous.length + 1 + firstWord.length > cols - 1
}

function joinWrapped(previous: string, rest: string, previousLine: string, cols: number): string {
  // A line filled to the last column broke inside a word (a long path).
  return previousLine.length >= cols - 1 ? `${previous}${rest}` : `${previous} ${rest}`
}

/** One option line, or null when the line is no option. */
function readOption(line: string, numbered: boolean, index: number): OptionDraft | null {
  const match = (numbered ? NUMBERED_OPTION : UNNUMBERED_OPTION).exec(line)
  if (match === null) return null
  const text = numbered ? (match[3] ?? "") : (match[2] ?? "")
  let labelCol = line.length - text.length
  let label = text
  let checked: boolean | null = null
  const tick = TICK_BOX.exec(text)
  if (tick !== null) {
    checked = tick[1] === "✔"
    label = text.slice(tick[0].length)
    labelCol += tick[0].length
  }
  return {
    key: numbered ? (match[2] ?? "") : String(index + 1),
    label: label.trim(),
    detail: null,
    cursor: line.trimStart().startsWith(CURSOR),
    checked,
    freeText: false,
    labelCol,
  }
}

/** The tabs of a form from its tab bar, without the Submit step; null when an item is unknown. */
function readTabs(bar: string): TerminalMenu["tabs"] {
  const items = bar.split(/\s{2,}/)
  const tabs: NonNullable<TerminalMenu["tabs"]> = []
  for (const item of items) {
    const match = /^([☐☒✔]) (.+)$/.exec(item)
    if (match === null) return null
    if (match[1] === "✔" && match[2] === "Submit") continue
    tabs.push({ label: match[2] ?? "", answered: match[1] === "☒" })
  }
  return tabs
}

/**
 * Join a question's lines: wrapped lines with spaces, answer list lines (●
 * and →) on their own lines, without the quote bar (│) Claude Code draws on
 * the left of some questions.
 */
function joinQuestion(lines: string[]): string {
  return lines
    .map((line) => line.trim().replace(/^│\s*/, ""))
    .reduce((joined, line, index) => {
      if (index === 0) return line
      return /^[●→]/.test(line) ? `${joined}\n${line}` : `${joined} ${line}`
    }, "")
}

/** The nearest of up to three paragraphs above the options that asks something. */
function readQuestion(lines: string[], top: number): string | null {
  let index = top - 1
  for (let paragraph = 0; paragraph < 3; paragraph += 1) {
    while (index >= 0 && (lines[index]?.trim() === "" || RULE.test(lines[index] ?? ""))) {
      if (RULE.test(lines[index] ?? "")) return null
      index -= 1
    }
    const found: string[] = []
    while (index >= 0 && lines[index]?.trim() !== "" && !RULE.test(lines[index] ?? "")) {
      found.unshift(lines[index] ?? "")
      index -= 1
    }
    if (found.length === 0) return null
    if (found.some((line) => line.includes("?"))) return joinQuestion(found)
  }
  return null
}

function menuId(menu: Omit<TerminalMenu, "id">): string {
  const identity = [
    menu.question,
    menu.multiSelect,
    menu.options.map((option) => [option.key, option.freeText ? "" : option.label]),
    menu.tabs?.map((tab) => tab.label) ?? null,
  ]
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16)
}

/**
 * The menu at the bottom of a rendered screen (`terminal.screenText` text,
 * `cols` wide), or null when there is none or its shape is not known.
 */
export function parseTerminalMenu(text: string, cols: number): ParsedMenu | null {
  const lines = text.split("\n").map((line) => line.trimEnd())
  let last = lines.length - 1
  while (last >= 0 && lines[last] === "") last -= 1
  if (last < 0) return null
  const footerLine = lines[last]?.trim() ?? ""
  const footer = FOOTERS.find((pattern) => pattern.test(footerLine)) ?? null
  const reviewTitle = lines.findLastIndex((line) => line.trim() === REVIEW_TITLE)
  const review = footer === null && reviewTitle >= 0
  if (footer === null && !review) return null
  const numbered = footer !== TRUST_FOOTER

  // The option block: the lines above the footer up to a blank line, from
  // its first option line. Numbered options can be followed by indented
  // detail lines, dividers and a Submit row; options without numbers stand
  // alone (the trust prompt).
  let end = footer === null ? last : last - 1
  while (end >= 0 && lines[end] === "") end -= 1
  const inBlock = (line: string): boolean =>
    line !== "" &&
    (numbered
      ? NUMBERED_OPTION.test(line) ||
        RULE.test(line) ||
        SUBMIT_LINE.test(line.trim()) ||
        indentOf(line) >= 2
      : !RULE.test(line))
  let top = end
  while (top - 1 >= 0 && inBlock(lines[top - 1] ?? "")) top -= 1
  while (numbered && top <= end && !NUMBERED_OPTION.test(lines[top] ?? "")) top += 1
  if (top > end) return null

  const options: OptionDraft[] = []
  const rows: ParsedMenu["rows"] = []
  let cursorRow = -1
  let labelOpen = false
  for (let index = top; index <= end; index += 1) {
    const line = lines[index] ?? ""
    const current = options.at(-1)
    const multi = options.some((option) => option.checked !== null)
    // In a question, the option just above a divider or the Submit row takes typed text.
    if (RULE.test(line) || (multi && SUBMIT_LINE.test(line.trim()))) {
      if (current && footer === QUESTION_FOOTER) current.freeText = true
      if (!RULE.test(line)) {
        if (line.trimStart().startsWith(CURSOR)) cursorRow = rows.length
        rows.push(SUBMIT_ROW)
      }
      labelOpen = false
      continue
    }
    const option =
      !numbered || NUMBERED_OPTION.test(line) ? readOption(line, numbered, options.length) : null
    if (option !== null) {
      if (option.cursor) cursorRow = rows.length
      options.push(option)
      rows.push(option.key)
      labelOpen = true
      continue
    }
    if (current === undefined || indentOf(line) < current.labelCol) return null
    const previous = lines[index - 1] ?? ""
    const rest = line.trim()
    if (labelOpen && wrapped(previous, line, cols)) {
      current.label = joinWrapped(current.label, rest, previous, cols)
    } else if (current.detail !== null && wrapped(previous, line, cols)) {
      current.detail = joinWrapped(current.detail, rest, previous, cols)
    } else {
      current.detail = current.detail === null ? rest : `${current.detail} ${rest}`
      labelOpen = false
    }
  }
  if (options.length === 0 || options.length > MAX_OPTIONS || cursorRow < 0) return null
  if (numbered && options.some((option, index) => option.key !== String(index + 1))) return null
  for (const option of options) {
    if (FREE_TEXT_LABELS.has(option.label)) option.freeText = true
  }

  let tabs: TerminalMenu["tabs"] = null
  for (let index = top - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ""
    if (RULE.test(line)) break
    const bar = TAB_BAR.exec(line.trim())
    if (bar !== null) {
      tabs = readTabs(bar[1] ?? "")
      if (tabs === null) return null
      break
    }
  }
  if (review && tabs === null) return null

  const question = review
    ? joinQuestion(lines.slice(reviewTitle, top).filter((line) => line.trim() !== ""))
    : readQuestion(lines, top)
  const body: Omit<TerminalMenu, "id"> = {
    question,
    multiSelect: options.some((option) => option.checked !== null),
    options: options.map(({ labelCol: _labelCol, ...option }) => option),
    tabs,
  }
  return { menu: { id: menuId(body), ...body }, numbered, rows, cursorRow, review }
}

/** Arrow keys from the cursor's row to row `target`. */
function arrowsTo(parsed: ParsedMenu, target: number): string[] {
  const steps = target - parsed.cursorRow
  return Array.from({ length: Math.abs(steps) }, () => (steps > 0 ? DOWN : UP))
}

/**
 * The keys that carry out `action` on `parsed`, or null when the action does
 * not fit the menu (an unknown option, text for an option that takes none,
 * Submit outside a multi-select question).
 */
export function menuKeys(parsed: ParsedMenu, action: MenuAction): MenuKeys | null {
  const { menu } = parsed
  // A single choice ends the menu, except a pick in a form that moves on to its next question.
  const endsMenu = !menu.multiSelect && (menu.tabs === null || parsed.review)
  if (action.kind === "submit") {
    const submit = parsed.rows.indexOf(SUBMIT_ROW)
    if (!menu.multiSelect || submit < 0) return null
    return { writes: [...arrowsTo(parsed, submit), "\r"], finishes: false }
  }
  const option = menu.options.find((candidate) => candidate.key === action.option)
  if (option === undefined) return null
  const row = parsed.rows.indexOf(option.key)
  if (action.kind === "choose") {
    if (option.freeText && !menu.multiSelect) return null
    if (parsed.numbered) return { writes: [option.key], finishes: endsMenu }
    return { writes: [...arrowsTo(parsed, row), "\r"], finishes: endsMenu }
  }
  const text = action.text.replace(/\s*\n\s*/g, " ").trim()
  if (!option.freeText || text.length === 0 || !parsed.numbered) return null
  if (menu.multiSelect) return { writes: [...arrowsTo(parsed, row), text], finishes: false }
  return { writes: [option.key, text, "\r"], finishes: endsMenu }
}
