/**
 * Minimal, dependency-free reader for a SKILL.md's leading frontmatter block.
 *
 * A skill file opens with a fenced block of flat "key: value" lines between two
 * triple-dash rules (see any .agents/skills/SKILL.md):
 *
 *   ---
 *   name: ticket-format
 *   description: How we structure tickets.
 *   ---
 *   # body...
 *
 * The Skills science tab only surfaces the two
 * scalar fields it displays (name and description), so a YAML dependency is
 * unwarranted; a tiny line parser covers the shape we author. The parser is
 * total: any input (no block, an unterminated block, blank values, CRLF) yields
 * a well-formed result with the keys it could read, never a throw.
 */

/** The frontmatter fields the Skills tab reads off a SKILL.md. */
export interface SkillFrontmatter {
  /** "name" value, trimmed. Empty string when absent (the caller falls back). */
  name: string
  /** "description" value, trimmed. Empty string when absent. */
  description: string
}

/**
 * Match a frontmatter block: a leading triple-dash line, the body, then a
 * closing triple-dash line. CRLF-tolerant and anchored to the start, so only a
 * true leading block counts (a triple-dash later in the body is not
 * frontmatter).
 */
const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * Read the leading frontmatter of a SKILL.md. Returns name/description (each
 * defaulting to "" when missing) parsed from the flat "key: value" lines;
 * unknown keys are ignored. Never throws.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const result: SkillFrontmatter = { name: "", description: "" }

  const block = content.match(FRONTMATTER_BLOCK)
  if (!block) return result

  for (const line of (block[1] ?? "").split("\n")) {
    const separator = line.indexOf(":")
    if (separator === -1) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (key === "name") result.name = value
    else if (key === "description") result.description = value
  }

  return result
}
