/**
 * YAML front matter at the top of a Markdown, Quarto or MyST file: a block that
 * opens with a `---` line on the first line and closes with the next `---`
 * line. Pure and browser-safe, shared by the diary router and the renderer.
 */

/** A file split into its front matter (the YAML between the fences, or null) and the rest. */
export interface FrontMatterSplit {
  frontMatter: string | null
  body: string
}

/** Split off a leading front matter block. Text without a closed block is all body. */
export function splitFrontMatter(content: string): FrontMatterSplit {
  const lines = content.split("\n")
  if (lines[0]?.trimEnd() !== "---") return { frontMatter: null, body: content }
  const close = lines.findIndex((line, at) => at > 0 && line.trimEnd() === "---")
  if (close === -1) return { frontMatter: null, body: content }
  return {
    frontMatter: lines.slice(1, close).join("\n"),
    body: lines.slice(close + 1).join("\n"),
  }
}
