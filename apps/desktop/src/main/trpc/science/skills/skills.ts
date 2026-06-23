import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { projects } from "@skipper/local-db"
import { listDir, readTextFile } from "@skipper/workspace-fs"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { publicProcedure, router } from "../../trpc"
import { parseSkillFrontmatter } from "./frontmatter"

/**
 * Skills science tab (AGENTS.md §1 "Science tabs") — v1 is a **read-only
 * catalog**: discover the agent skills declared in a project's repo and display
 * them. Triggering a skill from the GUI is a later (v2) concern and has no
 * procedure here.
 *
 * A "skill" is a `<dir>/SKILL.md` whose leading frontmatter names it. Agents
 * keep skills under two conventional directories at the repo root —
 * `.claude/skills` and `.agents/skills` (CLAUDE.md Rule 3: `.claude/skills` is
 * typically a symlink to `.agents/skills`). We scan both, parse each file's
 * frontmatter, and return one flat catalog. The router is thin: it resolves the
 * project's repo path from the injected Drizzle handle, then delegates the scan
 * to {@link discoverSkills} (a plain, filesystem-only function).
 */

/** The two repo-relative directories a project's skills are declared under. */
const SKILL_DIRS = [
  { source: ".claude/skills", segments: [".claude", "skills"] },
  { source: ".agents/skills", segments: [".agents", "skills"] },
] as const

/** Which conventional directory a discovered skill came from (drives the badge). */
export type SkillSource = (typeof SKILL_DIRS)[number]["source"]

/** One entry in the read-only skills catalog returned by `list`. */
export interface ScienceSkill {
  /** Frontmatter `name`, falling back to the skill's directory name. */
  name: string
  /** Frontmatter `description` (empty string when the file declares none). */
  description: string
  /** The skill directory's own name under its source dir (stable id / key). */
  slug: string
  /** Absolute path to the `SKILL.md` file. */
  path: string
  /** The conventional directory the skill was found under. */
  source: SkillSource
}

const listInput = z.object({
  /** The project whose repo is scanned for skills. */
  projectId: z.string().min(1),
})

/**
 * Discover every skill declared under `repoPath`'s conventional skill
 * directories. For each directory that exists, every immediate child folder is
 * probed for a `SKILL.md`; a readable file becomes a catalog entry parsed for
 * its `name`/`description` (name falls back to the folder name).
 *
 * Pure filesystem read — never throws on a missing directory or unreadable
 * file (a project may have neither dir, or a skill folder without a SKILL.md);
 * those are simply absent from the catalog. `.claude/skills` is commonly a
 * symlink to `.agents/skills`, so entries are de-duplicated by the SKILL.md's
 * real path, keeping the first source encountered (`.claude/skills`).
 */
export async function discoverSkills(repoPath: string): Promise<ScienceSkill[]> {
  const byRealPath = new Map<string, ScienceSkill>()

  for (const dir of SKILL_DIRS) {
    const skillsDir = join(repoPath, ...dir.segments)

    let children: Awaited<ReturnType<typeof listDir>>
    try {
      children = await listDir(skillsDir)
    } catch {
      // The directory doesn't exist (or isn't readable) — no skills from it.
      continue
    }

    for (const child of children) {
      if (child.kind !== "dir") continue
      const path = join(child.path, "SKILL.md")

      let content: string
      try {
        content = await readTextFile(path)
      } catch {
        // No SKILL.md in this folder — not a skill.
        continue
      }

      // Resolve the SKILL.md's real path so a symlinked `.claude/skills`
      // pointing at `.agents/skills` doesn't list every skill twice.
      let realKey: string
      try {
        realKey = await realpath(path)
      } catch {
        realKey = path
      }
      if (byRealPath.has(realKey)) continue

      const frontmatter = parseSkillFrontmatter(content)
      byRealPath.set(realKey, {
        name: frontmatter.name || child.name,
        description: frontmatter.description,
        slug: child.name,
        path,
        source: dir.source,
      })
    }
  }

  return [...byRealPath.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export const skillsRouter = router({
  /**
   * List the skills declared in a project's repo (read-only). Resolves the
   * project's repo path from the store, then scans its skill directories.
   * Returns an alphabetized catalog; a project with no skills yields `[]`.
   */
  list: publicProcedure.input(listInput).query(async ({ ctx, input }): Promise<ScienceSkill[]> => {
    const project = ctx.db.select().from(projects).where(eq(projects.id, input.projectId)).get()
    if (!project) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.projectId}` })
    }
    return discoverSkills(project.repoPath)
  }),
})
