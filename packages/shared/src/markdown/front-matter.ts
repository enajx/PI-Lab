/**
 * YAML front matter at the top of a Markdown, Quarto or MyST file: a block that
 * opens with a `---` line (after any blank lines) and closes with the next `---`
 * line. `\n` and `\r\n` line endings both work. Pure and browser-safe, shared by
 * the diary router and the renderer.
 */

/**
 * A file split into its front matter (the YAML between the fences, or null) and
 * the rest. `block` is the text before `body` (blank lines, fences and YAML), so
 * `block + body` is the whole file; it is "" when there is no front matter.
 */
export interface FrontMatterSplit {
  frontMatter: string | null
  body: string
  block: string
}

const OPEN_FENCE = /^(?:[ \t]*\r?\n)*---[ \t]*\r?\n/
const CLOSE_FENCE = /^---[ \t]*(?:\r?\n|$)/m

/** Split off a leading front matter block. Text without a closed block is all body. */
export function splitFrontMatter(content: string): FrontMatterSplit {
  const open = OPEN_FENCE.exec(content)
  if (!open) return { frontMatter: null, body: content, block: "" }
  const rest = content.slice(open[0].length)
  const close = CLOSE_FENCE.exec(rest)
  if (!close) return { frontMatter: null, body: content, block: "" }
  const end = open[0].length + close.index + close[0].length
  return {
    frontMatter: rest.slice(0, close.index).replace(/\r?\n$/, ""),
    body: content.slice(end),
    block: content.slice(0, end),
  }
}
