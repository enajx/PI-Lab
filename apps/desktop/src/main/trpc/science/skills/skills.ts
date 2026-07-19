import type { Dirent } from "node:fs"
import { readdir, readFile, realpath } from "node:fs/promises"
import { join } from "node:path"
import { projects } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { publicProcedure, router } from "../../trpc"
import { parseSkillFrontmatter } from "./frontmatter"

/**
 * Skills are indexed read-only in place. Project-local roots are scanned before
 * the matching global roots so their cards are always presented first:
 *
 *   project: .claude/skills, .codex/skills, .agents/skills
 *   global:  ~/.claude/skills, ~/.codex/skills, ~/.agents/skills
 *
 * Each supported root contains one directory per skill and a `SKILL.md` inside
 * that directory. Root and skill-directory symlinks are followed, while exact
 * aliases are de-duplicated by the SKILL.md's real path. Equal names at distinct
 * paths remain distinct catalog entries.
 */

const HARNESS_ROOTS = [
  {
    harness: "claude",
    segments: [".claude", "skills"],
    projectSource: ".claude/skills",
    globalSource: "~/.claude/skills",
  },
  {
    harness: "codex",
    segments: [".codex", "skills"],
    projectSource: ".codex/skills",
    globalSource: "~/.codex/skills",
  },
  {
    harness: "agents",
    segments: [".agents", "skills"],
    projectSource: ".agents/skills",
    globalSource: "~/.agents/skills",
  },
] as const

export type SkillHarness = (typeof HARNESS_ROOTS)[number]["harness"]
export type SkillScope = "project" | "global"
export type SkillSource =
  | (typeof HARNESS_ROOTS)[number]["projectSource"]
  | (typeof HARNESS_ROOTS)[number]["globalSource"]
export type SkillRootStatus = "available" | "missing" | "partial" | "unreadable"

/** One entry in the read-only Skills catalog. */
export interface ScienceSkill {
  name: string
  description: string
  slug: string
  /** Absolute path to the indexed SKILL.md; PI Lab never copies it. */
  path: string
  source: SkillSource
  harness: SkillHarness
  scope: SkillScope
}

/** Visibility and failure state for one of the six conventional roots. */
export interface ScienceSkillRoot {
  source: SkillSource
  harness: SkillHarness
  scope: SkillScope
  path: string
  status: SkillRootStatus
  /** Selectable diagnostic text for unreadable/partially-readable roots. */
  detail: string | null
}

export interface ScienceSkillsCatalog {
  skills: ScienceSkill[]
  roots: ScienceSkillRoot[]
}

interface SkillRootDefinition {
  source: SkillSource
  harness: SkillHarness
  scope: SkillScope
  path: string
}

const listInput = z.object({
  projectId: z.string().min(1),
})

function rootsFor(repoPath: string, homeDir: string): SkillRootDefinition[] {
  return [
    ...HARNESS_ROOTS.map(
      (root): SkillRootDefinition => ({
        source: root.projectSource,
        harness: root.harness,
        scope: "project",
        path: join(repoPath, ...root.segments),
      }),
    ),
    ...HARNESS_ROOTS.map(
      (root): SkillRootDefinition => ({
        source: root.globalSource,
        harness: root.harness,
        scope: "global",
        path: join(homeDir, ...root.segments),
      }),
    ),
  ]
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null
  return typeof error.code === "string" ? error.code : null
}

function errorDetail(source: SkillSource, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `Could not read ${source}: ${message}`
}

function compareSkills(a: ScienceSkill, b: ScienceSkill): number {
  const scopeOrder = Number(a.scope === "global") - Number(b.scope === "global")
  if (scopeOrder !== 0) return scopeOrder
  const nameOrder = a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  if (nameOrder !== 0) return nameOrder
  return a.path.localeCompare(b.path)
}

/**
 * Scan all six roots without letting one absent or unreadable location fail the
 * whole catalog. Missing roots are normal and explicit; unreadable roots and
 * individual unreadable SKILL.md files are returned as root diagnostics.
 */
export async function discoverSkills(
  repoPath: string,
  homeDir: string,
): Promise<ScienceSkillsCatalog> {
  const byRealPath = new Map<string, ScienceSkill>()
  const roots: ScienceSkillRoot[] = []

  for (const root of rootsFor(repoPath, homeDir)) {
    let children: Dirent<string>[]
    try {
      children = await readdir(root.path, { withFileTypes: true })
    } catch (error) {
      const missing = errorCode(error) === "ENOENT"
      roots.push({
        ...root,
        status: missing ? "missing" : "unreadable",
        detail: missing ? null : errorDetail(root.source, error),
      })
      continue
    }

    const details: string[] = []
    for (const child of children) {
      if (!child.isDirectory() && !child.isSymbolicLink()) continue
      const path = join(root.path, child.name, "SKILL.md")

      let content: string
      try {
        content = await readFile(path, "utf8")
      } catch (error) {
        if (errorCode(error) !== "ENOENT") details.push(errorDetail(root.source, error))
        continue
      }

      let realKey: string
      try {
        realKey = await realpath(path)
      } catch (error) {
        realKey = path
        details.push(errorDetail(root.source, error))
      }
      if (byRealPath.has(realKey)) continue

      const frontmatter = parseSkillFrontmatter(content)
      byRealPath.set(realKey, {
        name: frontmatter.name || child.name,
        description: frontmatter.description,
        slug: child.name,
        path,
        source: root.source,
        harness: root.harness,
        scope: root.scope,
      })
    }

    roots.push({
      ...root,
      status: details.length > 0 ? "partial" : "available",
      detail: details.length > 0 ? details.join("\n") : null,
    })
  }

  return { skills: [...byRealPath.values()].sort(compareSkills), roots }
}

export const skillsRouter = router({
  list: publicProcedure
    .input(listInput)
    .query(async ({ ctx, input }): Promise<ScienceSkillsCatalog> => {
      const project = ctx.db.select().from(projects).where(eq(projects.id, input.projectId)).get()
      if (!project) {
        throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.projectId}` })
      }
      return discoverSkills(project.repoPath, ctx.skillsHomeDir)
    }),
})
