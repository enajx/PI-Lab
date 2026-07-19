// Integration tests for the science.skills router via createCallerFactory over a
// temp SQLite DB with the real migrations and a real temp git repo (AGENTS.md
// md/engineering/testing-and-build.md). Skills are read off real files written into the repo's `.claude/skills`
// and their global counterparts — no mocking of the filesystem.
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { TRPCError } from "@trpc/server"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, type Harness } from "../../testHarness"

let h: Harness

beforeEach(async () => {
  h = await createHarness()
})

afterEach(async () => {
  await h.dispose()
})

/** Write a `<dir>/<slug>/SKILL.md` under the harness repo with the given body. */
async function writeSkill(dir: string, slug: string, body: string): Promise<void> {
  const skillDir = join(h.repoDir, dir, slug)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, "SKILL.md"), body)
}

async function writeGlobalSkill(dir: string, slug: string, body: string): Promise<void> {
  const skillDir = join(h.skillsHomeDir, dir, slug)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, "SKILL.md"), body)
}

function frontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
}

describe("science.skills.list", () => {
  test("discovers project-local Codex skills and labels their scope and harness", async () => {
    await writeSkill(".codex/skills", "codex-local", frontmatter("codex-local", "Codex skill."))

    const project = await h.caller.projects.open({ path: h.repoDir })
    const catalog = await h.caller.science.skills.list({ projectId: project.id })

    expect(catalog.skills).toContainEqual(
      expect.objectContaining({
        name: "codex-local",
        scope: "project",
        harness: "codex",
      }),
    )
  })

  test("discovers skills from both .claude/skills and .agents/skills with source + frontmatter", async () => {
    await writeSkill(".claude/skills", "deslop", frontmatter("deslop", "Clean up code."))
    await writeSkill(
      ".agents/skills",
      "ticket-format",
      frontmatter("ticket-format", "Ticket spec."),
    )

    const project = await h.caller.projects.open({ path: h.repoDir })
    const catalog = await h.caller.science.skills.list({ projectId: project.id })
    const skills = catalog.skills

    expect(skills.map((s) => s.name)).toEqual(["deslop", "ticket-format"])

    const deslop = skills.find((s) => s.slug === "deslop")
    expect(deslop).toMatchObject({
      name: "deslop",
      description: "Clean up code.",
      source: ".claude/skills",
      harness: "claude",
      scope: "project",
    })
    expect(deslop?.path).toBe(join(h.repoDir, ".claude", "skills", "deslop", "SKILL.md"))

    const ticket = skills.find((s) => s.slug === "ticket-format")
    expect(ticket).toMatchObject({ description: "Ticket spec.", source: ".agents/skills" })
  })

  test("indexes all six conventional roots with project-local skills before global skills", async () => {
    await writeSkill(".claude/skills", "z-project-claude", frontmatter("z project claude", ""))
    await writeSkill(".codex/skills", "z-project-codex", frontmatter("z project codex", ""))
    await writeSkill(".agents/skills", "z-project-agents", frontmatter("z project agents", ""))
    await writeGlobalSkill(".claude/skills", "a-global-claude", frontmatter("a global claude", ""))
    await writeGlobalSkill(".codex/skills", "a-global-codex", frontmatter("a global codex", ""))
    await writeGlobalSkill(".agents/skills", "a-global-agents", frontmatter("a global agents", ""))

    const project = await h.caller.projects.open({ path: h.repoDir })
    const catalog = await h.caller.science.skills.list({ projectId: project.id })

    expect(catalog.skills).toHaveLength(6)
    expect(catalog.skills.map((skill) => skill.scope)).toEqual([
      "project",
      "project",
      "project",
      "global",
      "global",
      "global",
    ])
    expect(catalog.skills.map((skill) => skill.harness).sort()).toEqual([
      "agents",
      "agents",
      "claude",
      "claude",
      "codex",
      "codex",
    ])
    expect(catalog.roots.map((root) => root.status)).toEqual([
      "available",
      "available",
      "available",
      "available",
      "available",
      "available",
    ])
  })

  test("keeps same-name project-local and global skills when their real paths differ", async () => {
    await writeSkill(".agents/skills", "shared", frontmatter("shared", "project copy"))
    await writeGlobalSkill(".agents/skills", "shared", frontmatter("shared", "global copy"))

    const project = await h.caller.projects.open({ path: h.repoDir })
    const { skills } = await h.caller.science.skills.list({ projectId: project.id })

    expect(skills).toHaveLength(2)
    expect(skills.map((skill) => [skill.scope, skill.description])).toEqual([
      ["project", "project copy"],
      ["global", "global copy"],
    ])
  })

  test("falls back to the folder name when frontmatter has no name", async () => {
    await writeSkill(".agents/skills", "no-name-skill", "---\ndescription: just a desc\n---\n")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const { skills } = await h.caller.science.skills.list({ projectId: project.id })

    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      name: "no-name-skill",
      description: "just a desc",
      slug: "no-name-skill",
    })
  })

  test("a folder without a SKILL.md is not a skill", async () => {
    const bogusDir = join(h.repoDir, ".agents", "skills", "not-a-skill")
    await mkdir(bogusDir, { recursive: true })
    await writeFile(join(bogusDir, "README.md"), "# not a skill")
    await writeSkill(".agents/skills", "real", frontmatter("real", "yes"))

    const project = await h.caller.projects.open({ path: h.repoDir })
    const { skills } = await h.caller.science.skills.list({ projectId: project.id })

    expect(skills.map((s) => s.slug)).toEqual(["real"])
  })

  test("a project with no skill directories returns an empty catalog", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const catalog = await h.caller.science.skills.list({ projectId: project.id })
    expect(catalog.skills).toEqual([])
    expect(catalog.roots).toHaveLength(6)
    expect(catalog.roots.every((root) => root.status === "missing")).toBe(true)
  })

  test("reports an unreadable root explicitly while preserving skills from readable roots", async () => {
    await writeSkill(".agents/skills", "readable", frontmatter("readable", "still indexed"))
    await mkdir(join(h.skillsHomeDir, ".claude"), { recursive: true })
    await writeFile(join(h.skillsHomeDir, ".claude", "skills"), "not a directory")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const catalog = await h.caller.science.skills.list({ projectId: project.id })

    expect(catalog.skills.map((skill) => skill.name)).toEqual(["readable"])
    expect(catalog.roots.find((root) => root.source === "~/.claude/skills")).toMatchObject({
      status: "unreadable",
    })
    expect(catalog.roots.find((root) => root.source === "~/.claude/skills")?.detail).toContain(
      "Could not read ~/.claude/skills",
    )
  })

  test("de-duplicates when .claude/skills is a symlink to .agents/skills", async () => {
    await writeSkill(".agents/skills", "shared-skill", frontmatter("shared-skill", "once only"))
    // `.claude/skills` -> `.agents/skills` (the canonical PI Lab layout). The
    // same SKILL.md is then reachable via both roots; it must appear once. The
    // `.claude` parent must exist before the symlink can be created inside it.
    await mkdir(join(h.repoDir, ".claude"), { recursive: true })
    await symlink(join(h.repoDir, ".agents", "skills"), join(h.repoDir, ".claude", "skills"), "dir")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const { skills } = await h.caller.science.skills.list({ projectId: project.id })

    expect(skills).toHaveLength(1)
    // The first source wins: `.claude/skills` is scanned before `.agents/skills`.
    expect(skills[0]).toMatchObject({ slug: "shared-skill", source: ".claude/skills" })
  })

  test("an unknown projectId is a clean NOT_FOUND", async () => {
    await expect(h.caller.science.skills.list({ projectId: "missing" })).rejects.toBeInstanceOf(
      TRPCError,
    )
    await expect(h.caller.science.skills.list({ projectId: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})
