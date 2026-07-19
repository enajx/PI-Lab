/**
 * Pure terminal-output link scanner.
 *
 * Terminal agents (Claude Code, Codex, compilers, test runners, …) print file
 * references in a handful of recurring shapes — `src/app.ts:12:5`, `main.rs:40`,
 * `App.tsx(18,3)`, `report(7)`. PI Lab's terminal pane wants to turn those into
 * clickable jumps, so it needs to know *where* in a chunk of text each reference
 * sits and *what* it points at. This module answers exactly that and nothing
 * more: it is a side-effect-free string→matches function — no filesystem, no
 * resolution, no I/O. Whether a matched path actually exists on disk is the
 * caller's problem.
 *
 * Design goals:
 *   - **Total** — never throws, for any input (covered by property tests).
 *   - **Faithful spans** — for every match, `text.slice(index, index + length)`
 *     re-yields `raw`, so the UI can highlight the exact run it parsed.
 *   - **Conservative** — a bare word is only treated as a path when it carries a
 *     structural signal (a `/` separator or a recognised file extension) or an
 *     explicit location suffix; plain prose words are left alone.
 */

/** A file reference discovered inside a span of terminal text. */
export interface TerminalLink {
  /** The exact substring that was matched (path plus any location suffix). */
  raw: string
  /** The file path portion, with any location suffix stripped. */
  path: string
  /** 1-based line number, when the reference carried one. */
  line?: number
  /** 1-based column number, when the reference carried one. */
  column?: number
  /** Start offset of `raw` within the scanned text. */
  index: number
  /** Length of `raw`; `text.slice(index, index + length) === raw`. */
  length: number
}

/**
 * The path body of a candidate. We accept the usual filename characters plus the
 * separators that show up in real paths (`/`, `.`, `_`, `-`, `~`, `@`, `+`).
 * Crucially this set excludes `:`, `(`, `)`, whitespace and commas, so a location
 * suffix can never be swallowed into the path body and the scanner can't run off
 * the end of a token.
 */
const PATH_BODY = "[A-Za-z0-9_./~@+-]+"

/**
 * Location suffixes, longest/most-specific first so the alternation prefers the
 * richer form (`:12:5` over `:12`). Counting from group 1 = the path body, the
 * suffix capture groups are, in order:
 *   2 line, 3 column   — `:12:5`
 *   4 line             — `:12`
 *   5 line, 6 column   — `(12,5)` / `(12, 5)`
 *   7 line             — `(12)`
 */
const SUFFIX = "(?::(\\d+):(\\d+)|:(\\d+)|\\((\\d+)\\s*,\\s*(\\d+)\\)|\\((\\d+)\\))?"

/**
 * A candidate is a path body followed by an optional location suffix. We compile
 * one global, sticky-free regex and walk its matches; qualification (is this
 * really a path?) happens per-match in {@link parseTerminalLinks}.
 */
const CANDIDATE = new RegExp(`(${PATH_BODY})${SUFFIX}`, "g")

/** A token earns "looks like a file path" status if it has a separator… */
const HAS_SEPARATOR = /\//
/** …or a trailing extension of 1–8 alphanumerics on a non-empty basename. */
const HAS_EXTENSION = /[A-Za-z0-9](?:\.[A-Za-z0-9]+)*\.[A-Za-z0-9]{1,8}$/

/** Parse a captured numeric group into a positive integer, or undefined. */
function toPositive(group: string | undefined): number | undefined {
  if (group === undefined) return undefined
  // Group is `\d+`, so Number is exact and finite; guard 0 just in case.
  const value = Number(group)
  return value > 0 ? value : undefined
}

/**
 * Decide whether a bare path body (no location suffix) is path-like enough to
 * surface. With a suffix the structure already signals intent, so the caller
 * skips this gate; this is the conservative filter that keeps prose words out.
 */
function looksLikePath(body: string): boolean {
  if (HAS_SEPARATOR.test(body)) return true
  if (HAS_EXTENSION.test(body)) return true
  return false
}

/**
 * Scan `text` for file references and return every match in left-to-right order.
 *
 * Recognised forms (path body = letters, digits and `_./~@+-`):
 *   - `path:line:column`   → `{ path, line, column }`
 *   - `path:line`          → `{ path, line }`
 *   - `path(line,column)`  → `{ path, line, column }` (spaces around `,` ok)
 *   - `path(line)`         → `{ path, line }`
 *   - a bare path that contains `/` or ends in a file extension → `{ path }`
 *
 * Bare words with neither a separator, an extension, nor a location suffix are
 * deliberately ignored. The function is total: any malformed or adversarial
 * input yields `[]` rather than throwing.
 */
export function parseTerminalLinks(text: string): TerminalLink[] {
  const links: TerminalLink[] = []
  if (typeof text !== "string" || text.length === 0) return links

  try {
    // A fresh regex per call keeps `lastIndex` state local and the function
    // re-entrant; `CANDIDATE.source`/`.flags` clone the compiled pattern.
    const scanner = new RegExp(CANDIDATE.source, CANDIDATE.flags)
    for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) {
      const raw = match[0]
      const body = match[1]

      // Defensive: a zero-width match would loop forever; nudge past it.
      if (raw.length === 0) {
        scanner.lastIndex += 1
        continue
      }
      if (body === undefined) continue

      const line = toPositive(match[2] ?? match[4] ?? match[5] ?? match[7])
      const column = toPositive(match[3] ?? match[6])
      const hasSuffix = raw.length > body.length

      // A suffix is itself a strong signal; otherwise demand path-like shape.
      if (!hasSuffix && !looksLikePath(body)) continue

      const link: TerminalLink = {
        raw,
        path: body,
        index: match.index,
        length: raw.length,
      }
      if (line !== undefined) link.line = line
      if (column !== undefined) link.column = column
      links.push(link)
    }
  } catch {
    // Totality guarantee: never propagate a scanning error to the caller.
    return links
  }

  return links
}
