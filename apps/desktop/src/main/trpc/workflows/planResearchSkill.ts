import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { discoverSkills } from "../science/skills/skills"

/**
 * Find a skill's SKILL.md by folder name (`slug`): PI Lab's bundled skills
 * first, then the project's and user's skill folders. `label` names the skill
 * in errors. Throws when it is missing or empty; never creates placeholders.
 */
export async function findSkill(
  slug: string,
  label: string,
  projectDir: string,
  homeDir: string,
  bundledDir: string | undefined,
): Promise<{ path: string; content: string }> {
  const bundledPath = bundledDir ? join(bundledDir, slug, "SKILL.md") : null
  const bundled = bundledPath
    ? await readFile(bundledPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      })
    : null
  let path = bundledPath
  let content = bundled
  if (content === null) {
    const catalog = await discoverSkills(projectDir, homeDir)
    const skill = catalog.skills.find((entry) => entry.slug === slug)
    if (!skill) {
      const failures = catalog.roots.flatMap((root) => (root.detail ? [root.detail] : []))
      throw new Error(
        `${label} skill could not be found. Checked PI Lab's bundled skills and project/user .claude/skills, .codex/skills, and .agents/skills folders.${failures.length ? `\n${failures.join("\n")}` : ""}`,
      )
    }
    path = skill.path
    content = await readFile(path, "utf8")
  }
  if (!path || !content.trim()) throw new Error(`${label} skill is empty.`)
  return { path, content }
}

/** The error for an action (e.g. "Plan research") that has no skill linked in Settings. */
export function notLinkedMessage(label: string): string {
  return `${label} is not linked to a skill yet. Link one in Settings → Agents & worktrees.`
}

/**
 * The prompt for Plan research with the skill linked in Settings (`slug`): PI Lab's bundled
 * copy first, then project and user skills. Throws when no skill is linked or it is missing.
 */
export async function planResearchPrompt(
  slug: string,
  projectDir: string,
  homeDir: string,
  bundledDir: string | undefined,
): Promise<string> {
  if (!slug) throw new Error(notLinkedMessage("Plan research"))
  const { path, content } = await findSkill(slug, "Plan research", projectDir, homeDir, bundledDir)
  return `Use the ${slug} skill for this project. The skill is at ${path}. Resolve its relative file references from ${dirname(path)}. Follow its instructions and print the result for the user.\n\n${content}`
}
