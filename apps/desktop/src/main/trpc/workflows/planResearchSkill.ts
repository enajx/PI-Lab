import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { discoverSkills } from "../science/skills/skills"

/** Resolve the shipped skill first, then project and user skills, without creating placeholders. */
export async function planResearchPrompt(
  projectDir: string,
  homeDir: string,
  bundledDir: string | undefined,
): Promise<string> {
  const bundledPath = bundledDir ? join(bundledDir, "plan-research", "SKILL.md") : null
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
    const skill = catalog.skills.find((entry) => entry.slug === "plan-research")
    if (!skill) {
      const failures = catalog.roots.flatMap((root) => (root.detail ? [root.detail] : []))
      throw new Error(
        `Plan research skill could not be found. Checked PI Lab's bundled skills and project/user .claude/skills, .codex/skills, and .agents/skills folders.${failures.length ? `\n${failures.join("\n")}` : ""}`,
      )
    }
    path = skill.path
    content = await readFile(path, "utf8")
  }
  if (!path || !content.trim()) throw new Error("Plan research skill is empty.")
  return `Use the plan-research skill for this project. The skill is at ${path}. Resolve its relative file references from ${dirname(path)}. Follow its instructions and print the result for the user.\n\n${content}`
}
