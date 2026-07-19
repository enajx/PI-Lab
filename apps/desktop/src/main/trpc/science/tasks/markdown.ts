import { createHash, randomUUID } from "node:crypto"
import type { ScienceTask, TaskHeading, TaskSelector, TaskStatus } from "./model"

const RECOGNIZED_TAG = /(?:^|[ \t])#(id|status|priority|label|owner)\/([^\s#]+)/gi
const VALID_STATUS = new Set<TaskStatus>(["backlog", "planned", "wip", "done"])

interface SourceLine {
  start: number
  contentEnd: number
  end: number
  number: number
  text: string
  eol: string
}

interface HeadingRecord extends TaskHeading {
  start: number
  depth: number
  sectionEnd: number
  /** Start of the next heading at any depth, or EOF. */
  directContentEnd: number
}

/** Parser-only fields used to perform precise source edits. */
export interface ParsedTask extends ScienceTask {
  block: string
  firstLineEnd: number
  checkbox: " " | "x" | "X" | "~"
  indent: string
  marker: string
  spacing: string
  eol: string
  metadata: {
    id: string | null
    status: TaskStatus | null
    priority: string | null
    labels: string[]
    owner: string | null
  }
}

export interface ParsedTaskDocument {
  content: string
  revision: string
  newline: "\n" | "\r\n"
  headings: HeadingRecord[]
  boardHeadings: TaskHeading[]
  tasks: ParsedTask[]
}

/** A strong content revision used for optimistic writes. */
export function taskRevision(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`
}

/** Parse task checkboxes without imposing a machine-owned Markdown format. */
export function parseTaskDocument(
  content: string,
  project: { id: string; name: string },
  relPath: string,
): ParsedTaskDocument {
  const lines = splitLines(content)
  const headings = parseHeadings(lines, content.length)
  const selectedBoardHeadings = selectBoardHeadings(headings)
  const starts: Array<{
    lineIndex: number
    match: RegExpMatchArray
    heading: HeadingRecord | null
  }> = []
  const headingStack: HeadingRecord[] = []
  let fenced = false
  let fenceMarker = ""
  let headingIndex = 0

  for (const [lineIndex, line] of lines.entries()) {
    const fence = line.text.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fence) {
      const marker = capture(fence, 1).charAt(0)
      if (!fenced) {
        fenced = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        fenced = false
        fenceMarker = ""
      }
      continue
    }
    if (fenced) continue

    while (true) {
      const heading = headings[headingIndex]
      if (!heading || heading.start !== line.start) break
      headingStack.splice(heading.depth - 1)
      headingStack[heading.depth - 1] = heading
      headingIndex += 1
    }

    const match = line.text.match(/^([ \t]*)([-+*]|\d+[.)])([ \t]+)\[([ xX~])\]([ \t]*)(.*)$/)
    if (!match) continue
    const heading = [...headingStack].reverse().find(Boolean) ?? null
    starts.push({ lineIndex, match, heading })
  }

  const revision = taskRevision(content)
  const tasks = starts.map((start, index) => {
    const line = lines[start.lineIndex]
    if (!line) throw new Error("Task source line is missing")
    const nextTaskLineIndex = starts[index + 1]?.lineIndex ?? lines.length
    const indentWidth = visualIndent(capture(start.match, 1))
    let endLineIndex = start.lineIndex

    for (let i = start.lineIndex + 1; i < nextTaskLineIndex; i += 1) {
      const candidate = lines[i]
      if (!candidate) break
      if (isHeading(candidate.text)) break
      if (candidate.text.trim() === "") {
        endLineIndex = i
        continue
      }
      const candidateIndent = visualIndent(candidate.text.match(/^[ \t]*/)?.[0] ?? "")
      if (candidateIndent <= indentWidth) break
      endLineIndex = i
    }

    while (endLineIndex > start.lineIndex && lines[endLineIndex]?.text.trim() === "") {
      endLineIndex -= 1
    }

    const endLine = lines[endLineIndex]
    if (!endLine) throw new Error("Task block end line is missing")
    const blockEnd = endLine.end
    const rawTail = capture(start.match, 6)
    const parsedMetadata = parseMetadata(rawTail)
    const title = removeRecognizedTags(rawTail).trim()
    const checkbox = start.match[4] as ParsedTask["checkbox"]
    const status = parsedMetadata.status ?? statusFromCheckbox(checkbox)
    const id = parsedMetadata.id
    const sourceStart = line.start
    const key = id
      ? `${project.id}:${relPath}:id:${id}`
      : `${project.id}:${relPath}:source:${sourceStart}`
    const detailLines = lines.slice(start.lineIndex + 1, endLineIndex + 1)

    return {
      key,
      id,
      projectId: project.id,
      projectName: project.name,
      relPath,
      revision,
      title,
      details: extractDetails(detailLines, indentWidth),
      status,
      priority: parsedMetadata.priority,
      labels: parsedMetadata.labels,
      owner: parsedMetadata.owner,
      heading: start.heading
        ? { key: start.heading.key, label: start.heading.label, path: start.heading.path }
        : null,
      boardHeadingKey:
        selectedBoardHeadings.find(
          (heading) => sourceStart > heading.start && sourceStart < heading.sectionEnd,
        )?.key ?? null,
      source: { start: sourceStart, end: blockEnd, line: line.number },
      block: content.slice(sourceStart, blockEnd),
      firstLineEnd: line.end,
      checkbox,
      indent: capture(start.match, 1),
      marker: capture(start.match, 2),
      spacing: capture(start.match, 3),
      eol: line.eol,
      metadata: parsedMetadata,
    }
  })
  const idCounts = new Map<string, number>()
  for (const task of tasks) {
    if (task.id) idCounts.set(task.id, (idCounts.get(task.id) ?? 0) + 1)
  }
  for (const task of tasks) {
    if (task.id && (idCounts.get(task.id) ?? 0) > 1) {
      task.key = `${task.key}:source:${task.source.start}`
    }
  }

  return {
    content,
    revision,
    newline: content.includes("\r\n") ? "\r\n" : "\n",
    headings,
    boardHeadings: selectedBoardHeadings.map(toPublicHeading),
    tasks,
  }
}

/** Resolve a selector against one immutable document revision. */
export function selectTask(
  document: ParsedTaskDocument,
  selector: TaskSelector,
): ParsedTask | null {
  if ("id" in selector) {
    const matches = document.tasks.filter((task) => task.id === selector.id)
    return matches.length === 1 ? (matches.at(0) ?? null) : null
  }
  if ("key" in selector) {
    const matches = document.tasks.filter((task) => task.key === selector.key)
    return matches.length === 1 ? (matches.at(0) ?? null) : null
  }
  return document.tasks.find((task) => task.source.start === selector.sourceStart) ?? null
}

/** Return whether an id is duplicated and therefore unsafe as a mutation selector. */
export function hasDuplicateTaskId(document: ParsedTaskDocument, id: string): boolean {
  return document.tasks.filter((task) => task.id === id).length > 1
}

export interface TaskFields {
  title: string
  details: string
  status: TaskStatus
  priority: string | null
  labels: string[]
  owner: string | null
}

/**
 * Rewrite only one task block. Existing list indentation/marker and source EOL
 * are retained; an id is assigned on the first non-delete mutation.
 */
export function renderUpdatedTask(
  task: ParsedTask,
  fields: TaskFields,
  newline: "\n" | "\r\n",
): { block: string; id: string } {
  const id = task.id ?? shortTaskId()
  const checkbox = checkboxForStatus(fields.status)
  const firstLineEol = task.eol || newline
  const firstLine = `${task.indent}${task.marker}${task.spacing}[${checkbox}] ${renderTail(fields, id)}${firstLineEol}`
  const details = renderDetails(fields.details, task.indent, newline, task.block.endsWith("\n"))
  return { block: firstLine + details, id }
}

/** Render a newly created top-level Markdown task. */
export function renderNewTask(
  fields: TaskFields,
  newline: "\n" | "\r\n",
): { block: string; id: string } {
  const id = shortTaskId()
  const firstLine = `- [${checkboxForStatus(fields.status)}] ${renderTail(fields, id)}${newline}`
  return { block: firstLine + renderDetails(fields.details, "", newline, true), id }
}

function renderTail(fields: TaskFields, id: string): string {
  const tags = [`#id/${id}`, `#status/${fields.status}`]
  if (fields.priority) tags.push(`#priority/${fields.priority}`)
  for (const label of fields.labels) tags.push(`#label/${label}`)
  if (fields.owner) tags.push(`#owner/${fields.owner}`)
  return `${fields.title.trim()} ${tags.join(" ")}`.trim()
}

function renderDetails(
  details: string,
  indent: string,
  newline: "\n" | "\r\n",
  terminate: boolean,
): string {
  if (!details) return ""
  const normalized = details.replaceAll("\r\n", "\n").replace(/\n$/, "")
  const rendered = normalized
    .split("\n")
    .map((line) => `${indent}  ${line}`)
    .join(newline)
  return rendered + (terminate ? newline : "")
}

function parseMetadata(tail: string): ParsedTask["metadata"] {
  let id: string | null = null
  let status: TaskStatus | null = null
  let priority: string | null = null
  const labels: string[] = []
  let owner: string | null = null

  for (const match of tail.matchAll(RECOGNIZED_TAG)) {
    const kind = capture(match, 1).toLowerCase()
    const value = capture(match, 2)
    if (kind === "id" && id === null) id = value
    else if (kind === "status" && VALID_STATUS.has(value.toLowerCase() as TaskStatus)) {
      status = value.toLowerCase() as TaskStatus
    } else if (kind === "priority" && priority === null) priority = value
    else if (kind === "label") labels.push(value)
    else if (kind === "owner" && owner === null) owner = value
  }
  return { id, status, priority, labels, owner }
}

function removeRecognizedTags(tail: string): string {
  return tail.replace(RECOGNIZED_TAG, (match) => (match.startsWith("#") ? "" : match.charAt(0)))
}

function statusFromCheckbox(checkbox: ParsedTask["checkbox"]): TaskStatus {
  if (checkbox === "x" || checkbox === "X") return "done"
  if (checkbox === "~") return "wip"
  return "planned"
}

function checkboxForStatus(status: TaskStatus): string {
  if (status === "done") return "x"
  if (status === "wip") return "~"
  return " "
}

function extractDetails(lines: SourceLine[], parentIndent: number): string {
  return lines
    .map((line) => {
      if (line.text.trim() === "") return ""
      return removeVisualIndent(line.text, parentIndent + 2)
    })
    .join("\n")
}

function removeVisualIndent(value: string, width: number): string {
  let consumed = 0
  let index = 0
  while (index < value.length && consumed < width) {
    if (value[index] === "\t") consumed += 4 - (consumed % 4)
    else if (value[index] === " ") consumed += 1
    else break
    index += 1
  }
  return value.slice(index)
}

function visualIndent(indent: string): number {
  let width = 0
  for (const char of indent) width += char === "\t" ? 4 - (width % 4) : 1
  return width
}

function splitLines(content: string): SourceLine[] {
  const lines: SourceLine[] = []
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g
  let number = 1
  while (true) {
    const match = pattern.exec(content)
    if (match === null) break
    if (match[0] === "" && match.index === content.length) break
    const eol = capture(match, 2)
    const text = capture(match, 1)
    lines.push({
      start: match.index,
      contentEnd: match.index + text.length,
      end: match.index + match[0].length,
      number,
      text,
      eol,
    })
    number += 1
    if (pattern.lastIndex === content.length) break
  }
  return lines
}

function parseHeadings(lines: SourceLine[], contentEnd: number): HeadingRecord[] {
  const headings: HeadingRecord[] = []
  const stack: HeadingRecord[] = []
  let fenced = false
  let fenceMarker = ""

  for (const line of lines) {
    const fence = line.text.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fence) {
      const marker = capture(fence, 1).charAt(0)
      if (!fenced) {
        fenced = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        fenced = false
        fenceMarker = ""
      }
      continue
    }
    if (fenced) continue
    const match = line.text.match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/)
    if (!match) continue
    const depth = capture(match, 1).length
    const label = capture(match, 2).trim()
    stack.splice(depth - 1)
    const path = stack.filter(Boolean).map((heading) => heading.label)
    path.push(label)
    const heading: HeadingRecord = {
      key: `heading:${line.start}`,
      label,
      path,
      start: line.start,
      depth,
      sectionEnd: contentEnd,
      directContentEnd: contentEnd,
    }
    stack[depth - 1] = heading
    headings.push(heading)
  }

  for (const [i, heading] of headings.entries()) {
    const boundary = headings.slice(i + 1).find((candidate) => candidate.depth <= heading.depth)
    heading.sectionEnd = boundary?.start ?? contentEnd
    heading.directContentEnd = headings[i + 1]?.start ?? contentEnd
  }
  return headings
}

function isHeading(line: string): boolean {
  return /^ {0,3}#{1,6}[ \t]+/.test(line)
}

function capture(match: RegExpMatchArray | RegExpExecArray, index: number): string {
  const value = match[index]
  if (value === undefined) throw new Error(`Missing regular-expression capture ${index}`)
  return value
}

function shortTaskId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12)
}

/**
 * Select one useful document depth for Kanban columns. Repeated depths win by
 * column count; ties prefer the shallower, more human-prominent structure.
 */
function selectBoardHeadings(headings: HeadingRecord[]): HeadingRecord[] {
  if (headings.length === 0) return []
  const counts = new Map<number, number>()
  for (const heading of headings) counts.set(heading.depth, (counts.get(heading.depth) ?? 0) + 1)
  const repeatedDepths = [...counts.entries()].filter(([, count]) => count >= 2)
  const selectedDepth =
    repeatedDepths
      .sort(([depthA, countA], [depthB, countB]) => countB - countA || depthA - depthB)
      .at(0)?.[0] ?? Math.min(...counts.keys())
  return headings.filter((heading) => heading.depth === selectedDepth)
}

function toPublicHeading(heading: HeadingRecord): TaskHeading {
  return { key: heading.key, label: heading.label, path: heading.path }
}
