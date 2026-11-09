import { posix } from "node:path"

/** One heading in a LaTeX document outline. */
export interface OutlineEntry {
  /** 0 = part, 1 = chapter, 2 = section, 3 = subsection, 4 = subsubsection. */
  level: number
  /** Command name without the backslash, with a trailing `*` when starred. */
  command: string
  /** Title text between the braces, as written in the source. */
  title: string
  /** File the heading is in, relative to the paper folder, with `/` separators. */
  relPath: string
  /** 1-based line number of the heading in that file. */
  line: number
}

const HEADING_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
}

const COMMAND_PATTERN =
  /\\(part|chapter|section|subsection|subsubsection|input|include)(?![a-zA-Z])(\*?)/g

/** Remove a trailing `%` comment; `\%` is an escaped percent sign, not a comment. */
export function stripComment(line: string): string {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "\\") i += 1
    else if (line[i] === "%") return line.slice(0, i)
  }
  return line
}

/**
 * Read a group that starts at `start` (after optional spaces) with `open` and
 * ends at its matching `close`. Returns the inner text and the index after the
 * group, or null when there is no group there. An unclosed group takes the rest
 * of the line.
 */
function readGroup(
  text: string,
  start: number,
  open: string,
  close: string,
): { inner: string; end: number } | null {
  let i = start
  while (text[i] === " " || text[i] === "\t") i += 1
  if (text[i] !== open) return null
  let depth = 0
  for (let j = i; j < text.length; j += 1) {
    if (text[j] === "\\") {
      j += 1
      continue
    }
    if (text[j] === open) depth += 1
    else if (text[j] === close) {
      depth -= 1
      if (depth === 0) return { inner: text.slice(i + 1, j), end: j + 1 }
    }
  }
  return { inner: text.slice(i + 1), end: text.length }
}

/**
 * Turn an `\input`/`\include` argument into a path relative to the paper
 * folder (LaTeX resolves these from the folder of the root file). Adds `.tex`
 * when there is no extension. Returns null for paths that leave the folder.
 */
function includedPath(target: string): string | null {
  const trimmed = target.trim()
  if (trimmed.length === 0 || posix.isAbsolute(trimmed)) return null
  const normalized = posix.normalize(trimmed)
  if (normalized === ".." || normalized.startsWith("../")) return null
  return posix.extname(normalized) ? normalized : `${normalized}.tex`
}

/**
 * Build the outline of a LaTeX document starting at `rootRelPath`. Headings
 * (`\part` to `\subsubsection`, starred or not) are listed in document order,
 * following `\input` and `\include` into other files at the point they appear.
 * Commented text is ignored. Files that `read` returns null for (missing or
 * unreadable) are skipped, and each file is read at most once to stop cycles.
 */
export function buildOutline(
  rootRelPath: string,
  read: (relPath: string) => string | null,
): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  const visited = new Set<string>()

  const visit = (relPath: string): void => {
    if (visited.has(relPath)) return
    visited.add(relPath)
    const source = read(relPath)
    if (source === null) return
    const lines = source.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const text = stripComment(lines[index] ?? "")
      for (const match of text.matchAll(COMMAND_PATTERN)) {
        const name = match[1] ?? ""
        const star = match[2] ?? ""
        let after = (match.index ?? 0) + match[0].length
        if (name === "input" || name === "include") {
          const group = readGroup(text, after, "{", "}")
          const target = group ? includedPath(group.inner) : null
          if (target) visit(target)
          continue
        }
        const optional = readGroup(text, after, "[", "]")
        if (optional) after = optional.end
        const title = readGroup(text, after, "{", "}")
        if (!title) continue
        entries.push({
          level: HEADING_LEVELS[name] ?? 0,
          command: `${name}${star}`,
          title: title.inner.trim(),
          relPath,
          line: index + 1,
        })
      }
    }
  }

  visit(rootRelPath)
  return entries
}
