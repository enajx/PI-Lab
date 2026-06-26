// Integration tests for the science.skills router via createCallerFactory over a
// temp SQLite DB with the real migrations and a real temp git repo (AGENTS.md
// docs/testing-and-build.md). Skills are read off real files written into the repo's `.claude/skills`
// and `.agents/skills` directories — no mocking of the filesystem.
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

function frontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
}

describe("science.skills.list", () => {
  test("discovers skills from both .claude/skills and .agents/skills with source + frontmatter", async () => {
    await writeSkill(".claude/skills", "deslop", frontmatter("deslop", "Clean up code."))
    await writeSkill(
      ".agents/skills",
      "ticket-format",
      frontmatter("ticket-format", "Ticket spec."),
    )

    const project = await h.caller.projects.open({ path: h.repoDir })
    const skills = await h.caller.science.skills.list({ projectId: project.id })

    expect(skills.map((s) => s.name)).toEqual(["deslop", "ticket-format"])

    const deslop = skills.find((s) => s.slug === "deslop")
    expect(deslop).toMatchObject({
      name: "deslop",
      description: "Clean up code.",
      source: ".claude/skills",
    })
    expect(deslop?.path).toBe(join(h.repoDir, ".claude", "skills", "deslop", "SKILL.md"))

    const ticket = skills.find((s) => s.slug === "ticket-format")
    expect(ticket).toMatchObject({ description: "Ticket spec.", source: ".agents/skills" })
  })

  test("falls back to the folder name when frontmatter has no name", async () => {
    await writeSkill(".agents/skills", "no-name-skill", "---\ndescription: just a desc\n---\n")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const skills = await h.caller.science.skills.list({ projectId: project.id })

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
    const skills = await h.caller.science.skills.list({ projectId: project.id })

    expect(skills.map((s) => s.slug)).toEqual(["real"])
  })

  test("a project with no skill directories returns an empty catalog", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const skills = await h.caller.science.skills.list({ projectId: project.id })
    expect(skills).toEqual([])
  })

  test("de-duplicates when .claude/skills is a symlink to .agents/skills", async () => {
    await writeSkill(".agents/skills", "shared-skill", frontmatter("shared-skill", "once only"))
    // `.claude/skills` -> `.agents/skills` (the canonical Skipper layout). The
    // same SKILL.md is then reachable via both roots; it must appear once. The
    // `.claude` parent must exist before the symlink can be created inside it.
    await mkdir(join(h.repoDir, ".claude"), { recursive: true })
    await symlink(join(h.repoDir, ".agents", "skills"), join(h.repoDir, ".claude", "skills"), "dir")

    const project = await h.caller.projects.open({ path: h.repoDir })
    const skills = await h.caller.science.skills.list({ projectId: project.id })

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
