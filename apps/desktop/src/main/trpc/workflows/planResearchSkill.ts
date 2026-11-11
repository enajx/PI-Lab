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

/** Resolve the shipped skill first, then project and user skills, without creating placeholders. */
export async function planResearchPrompt(
  projectDir: string,
  homeDir: string,
  bundledDir: string | undefined,
): Promise<string> {
  const { path, content } = await findSkill(
    "plan-research",
    "Plan research",
    projectDir,
    homeDir,
    bundledDir,
  )
  return `Use the plan-research skill for this project. The skill is at ${path}. Resolve its relative file references from ${dirname(path)}. Follow its instructions and print the result for the user.\n\n${content}`
}
