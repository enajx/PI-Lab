import type { Text } from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view"

export type MarkdownMode = "render" | "source"

export interface MarkdownProjectEntry {
  name: string
  relPath: string
  kind: "file" | "dir"
}

export interface MarkdownSlashCommand {
  id: string
  label: string
  hint: string
  insert: string
  cursorOffset?: number
  children?: MarkdownSlashCommand[]
}

export const MARKDOWN_BLOCK_COMMANDS: MarkdownSlashCommand[] = [
  {
    id: "header",
    label: "Header",
    hint: "Section headings",
    insert: "",
    children: [
      { id: "heading-1", label: "Heading 1", hint: "Large section heading", insert: "# " },
      { id: "heading-2", label: "Heading 2", hint: "Medium section heading", insert: "## " },
      { id: "heading-3", label: "Heading 3", hint: "Small section heading", insert: "### " },
    ],
  },
  {
    id: "list",
    label: "List",
    hint: "Bulleted or numbered",
    insert: "",
    children: [
      { id: "bullet-list", label: "Bulleted list", hint: "Start a list", insert: "- " },
      { id: "numbered-list", label: "Numbered list", hint: "Start an ordered list", insert: "1. " },
    ],
  },
  { id: "quote", label: "Quote", hint: "Quoted block", insert: "> " },
  {
    id: "code-block",
    label: "Code block",
    hint: "Fenced code",
    insert: "```\n\n```",
    cursorOffset: 4,
  },
  { id: "link", label: "Link", hint: "Mention a file or URL", insert: "@" },
  { id: "divider", label: "Divider", hint: "Horizontal rule", insert: "---" },
  {
    id: "image",
    label: "Image",
    hint: "Image URL or project path",
    insert: "![Alt text](path/to/image.png)",
    cursorOffset: 2,
  },
  {
    id: "table",
    label: "Table",
    hint: "Two-column table",
    insert: "| Column 1 | Column 2 |\n| --- | --- |\n| Value 1 | Value 2 |",
  },
]

/** @deprecated Project paths are entered after the Link command inserts `@`. */
export function projectLinkCommands(entries: MarkdownProjectEntry[]): MarkdownSlashCommand[] {
  return entries.map((entry) => {
    const target = entry.kind === "dir" ? `${entry.relPath}/` : entry.relPath
    return {
      id: `project:${entry.kind}:${entry.relPath}`,
      label: `Link to ${entry.name}`,
      hint: entry.kind === "dir" ? "Project folder" : "Project file",
      insert: `[${entry.name}](${target})`,
    }
  })
}

/**
 * WYSIWYM-style Markdown presentation. The document remains ordinary editable
 * source: line/mark decorations only add hierarchy and spacing, while syntax
 * delimiters stay present with a quieter treatment.
 */
export const markdownRenderExtension = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = markdownDecorations(view.state.doc)
      }

      update(update: ViewUpdate) {
        if (update.docChanged) this.decorations = markdownDecorations(update.state.doc)
      }
    },
    { decorations: (plugin) => plugin.decorations },
  ),
  EditorView.editorAttributes.of({ class: "cm-md-render" }),
  EditorView.theme({
    ".cm-content": {
      padding: "1.5rem max(1.5rem, calc((100% - 52rem) / 2)) 4rem",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
    },
    ".cm-line": {
      paddingTop: "0.12rem",
      paddingBottom: "0.12rem",
    },
    ".cm-md-paragraph": {
      lineHeight: "1.8",
    },
    ".cm-md-blank": {
      minHeight: "0.7rem",
    },
    ".cm-md-heading-1, .cm-md-heading-2, .cm-md-heading-3, .cm-md-heading-4, .cm-md-heading-5, .cm-md-heading-6":
      {
        fontWeight: "700",
        lineHeight: "1.3",
        paddingTop: "0.7rem",
        paddingBottom: "0.25rem",
      },
    ".cm-md-heading-1": { fontSize: "2rem" },
    ".cm-md-heading-2": { fontSize: "1.55rem" },
    ".cm-md-heading-3": { fontSize: "1.3rem" },
    ".cm-md-heading-4": { fontSize: "1.15rem" },
    ".cm-md-heading-5": { fontSize: "1.05rem" },
    ".cm-md-heading-6": { fontSize: "1rem" },
    ".cm-md-source-mark": {
      opacity: "0.38",
      fontWeight: "400",
      fontStyle: "normal",
    },
    ".cm-md-strong": { fontWeight: "700" },
    ".cm-md-emphasis": { fontStyle: "italic" },
    ".cm-md-strike": { textDecoration: "line-through" },
    ".cm-md-inline-code": {
      borderRadius: "0.25rem",
      backgroundColor: "color-mix(in srgb, currentColor 8%, transparent)",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "0.9em",
      padding: "0.08rem 0.2rem",
    },
    ".cm-md-link-text": {
      color: "var(--color-primary)",
      textDecoration: "underline",
      textUnderlineOffset: "0.15em",
    },
    ".cm-md-list, .cm-md-quote": { lineHeight: "1.7" },
    ".cm-md-quote": {
      borderLeft: "3px solid color-mix(in srgb, currentColor 25%, transparent)",
      color: "color-mix(in srgb, currentColor 72%, transparent)",
      paddingLeft: "0.7rem",
    },
    ".cm-md-table": {
      backgroundColor: "color-mix(in srgb, currentColor 4%, transparent)",
      borderLeft: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
      borderRight: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      lineHeight: "1.8",
    },
    ".cm-md-table-cell": {
      paddingLeft: "0.35rem",
      paddingRight: "0.35rem",
    },
    ".cm-md-table-separator": { opacity: "0.55" },
    ".cm-md-code-fence": {
      backgroundColor: "color-mix(in srgb, currentColor 5%, transparent)",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
  }),
]

interface DecorationRange {
  from: number
  to: number
  value: Decoration
}

function markdownDecorations(doc: Text): DecorationSet {
  const ranges: DecorationRange[] = []
  let position = 0
  while (position <= doc.length) {
    const line = doc.lineAt(position)
    decorateLine(line.from, line.text, ranges)
    if (line.to === doc.length) break
    position = line.to + 1
  }
  return Decoration.set(
    ranges.map((range) => range.value.range(range.from, range.to)),
    true,
  )
}

function decorateLine(from: number, text: string, ranges: DecorationRange[]) {
  if (text.trim().length === 0) {
    addLine(from, "cm-md-blank", ranges)
    return
  }

  const heading = /^(#{1,6})(?:[ \t]+|$)/.exec(text)
  const list = /^(\s*)([-+*]|\d+[.)])(\s+)/.exec(text)
  const quote = /^(\s*>+\s*)/.exec(text)
  const fence = /^(\s*```.*)$/.exec(text)
  const divider = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.exec(text)
  const table = text.includes("|") && (/^\s*\|/.test(text) || /\|\s*$/.test(text))

  if (heading) {
    addLine(from, `cm-md-heading-${(heading[1] ?? "").length}`, ranges)
    addMark(from, from + heading[0].length, "cm-md-source-mark", ranges)
  } else if (list) {
    addLine(from, "cm-md-list", ranges)
    addMark(from + (list[1] ?? "").length, from + list[0].length, "cm-md-source-mark", ranges)
  } else if (quote) {
    addLine(from, "cm-md-quote", ranges)
    addMark(from, from + quote[0].length, "cm-md-source-mark", ranges)
  } else if (fence) {
    addLine(from, "cm-md-code-fence", ranges)
    addMark(from, from + fence[0].length, "cm-md-source-mark", ranges)
  } else if (divider) {
    addLine(from, "cm-md-divider", ranges)
    addMark(from, from + text.length, "cm-md-source-mark", ranges)
  } else if (table) {
    addLine(from, "cm-md-table", ranges)
    const separator = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(text)
    if (separator) addLine(from, "cm-md-table-separator", ranges)
    decorateTable(from, text, ranges)
  } else {
    addLine(from, "cm-md-paragraph", ranges)
  }

  decorateInline(from, text, ranges)
}

function decorateInline(from: number, text: string, ranges: DecorationRange[]) {
  addDelimited(text, from, /(\*\*|__)(.+?)\1/g, "cm-md-strong", ranges)
  addDelimited(text, from, /(~~)(.+?)\1/g, "cm-md-strike", ranges)
  addDelimited(text, from, /(`)([^`]+?)\1/g, "cm-md-inline-code", ranges)
  addDelimited(text, from, /(?<!\*)(\*)(?!\*)([^*\n]+?)\1(?!\*)/g, "cm-md-emphasis", ranges)
  addDelimited(text, from, /(?<!_)(_)(?!_)([^_\n]+?)\1(?!_)/g, "cm-md-emphasis", ranges)

  for (const match of text.matchAll(/(!?\[)([^\]]+)(\]\()([^)]+)(\))/g)) {
    const start = from + (match.index ?? 0)
    const bangAndOpen = (match[1] ?? "").length
    const labelStart = start + bangAndOpen
    const labelEnd = labelStart + (match[2] ?? "").length
    addMark(start, labelStart, "cm-md-source-mark", ranges)
    addMark(labelStart, labelEnd, "cm-md-link-text", ranges)
    addMark(labelEnd, start + match[0].length, "cm-md-source-mark", ranges)
  }
}

function addDelimited(
  text: string,
  from: number,
  pattern: RegExp,
  contentClass: string,
  ranges: DecorationRange[],
) {
  for (const match of text.matchAll(pattern)) {
    const start = from + (match.index ?? 0)
    const delimiterLength = (match[1] ?? "").length
    const contentStart = start + delimiterLength
    const contentEnd = start + match[0].length - delimiterLength
    addMark(start, contentStart, "cm-md-source-mark", ranges)
    addMark(contentStart, contentEnd, contentClass, ranges)
    addMark(contentEnd, start + match[0].length, "cm-md-source-mark", ranges)
  }
}

function decorateTable(from: number, text: string, ranges: DecorationRange[]) {
  const pipes: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "|") {
      pipes.push(index)
      addMark(from + index, from + index + 1, "cm-md-source-mark", ranges)
    }
  }
  for (let index = 0; index < pipes.length - 1; index += 1) {
    const startPipe = pipes[index]
    const end = pipes[index + 1]
    if (startPipe === undefined || end === undefined) continue
    const start = startPipe + 1
    if (end > start) addMark(from + start, from + end, "cm-md-table-cell", ranges)
  }
}

function addLine(from: number, className: string, ranges: DecorationRange[]) {
  ranges.push({ from, to: from, value: Decoration.line({ class: className }) })
}

function addMark(from: number, to: number, className: string, ranges: DecorationRange[]) {
  if (to <= from) return
  ranges.push({ from, to, value: Decoration.mark({ class: className }) })
}
