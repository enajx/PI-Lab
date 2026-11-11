import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, type Harness } from "../testHarness"
import { localDateHeading } from "./diary"

let h: Harness

beforeEach(async () => {
  h = await createHarness([], { git: false, daemon: "lazy" })
})

afterEach(async () => {
  await h.dispose()
})

const diaryDir = () => join(h.repoDir, "md", "research-diary")

describe("diary.open", () => {
  test("creates the diary with today's heading when the file is missing", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const today = localDateHeading(new Date())

    const opened = await h.caller.diary.open({ projectId: project.id })

    expect(opened.relPath).toBe("md/research-diary/diary.md")
    expect(opened.content).toBe(`${today}\n\n`)
    expect(await readFile(join(diaryDir(), "diary.md"), "utf8")).toBe(`${today}\n\n`)
  })

  test("adds today's heading at the top below the title, once", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const today = localDateHeading(new Date())
    await mkdir(diaryDir(), { recursive: true })
    await writeFile(join(diaryDir(), "diary.md"), "# My diary\n\n## 2020-01-02\n\nOld entry.\n")

    await h.caller.diary.open({ projectId: project.id })
    const again = await h.caller.diary.open({ projectId: project.id })

    const expected = `# My diary\n\n${today}\n\n## 2020-01-02\n\nOld entry.\n`
    expect(again.content).toBe(expected)
    expect(await readFile(join(diaryDir(), "diary.md"), "utf8")).toBe(expected)
  })

  test("renames diary.md to diary.qmd and back when the format setting changes", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const today = localDateHeading(new Date())
    await mkdir(diaryDir(), { recursive: true })
    await writeFile(join(diaryDir(), "diary.md"), `${today}\n\nEntry.\n`)

    await h.caller.settings.updateEditor({ researchDiaryFormat: "qmd" })
    const qmd = await h.caller.diary.open({ projectId: project.id })
    expect(qmd.relPath).toBe("md/research-diary/diary.qmd")
    expect(qmd.content).toBe(`${today}\n\nEntry.\n`)
    await expect(stat(join(diaryDir(), "diary.md"))).rejects.toThrow()

    await h.caller.settings.updateEditor({ researchDiaryFormat: "md" })
    const md = await h.caller.diary.open({ projectId: project.id })
    expect(md.relPath).toBe("md/research-diary/diary.md")
    expect(md.content).toBe(`${today}\n\nEntry.\n`)
    await expect(stat(join(diaryDir(), "diary.qmd"))).rejects.toThrow()
  })
})

describe("diary.save", () => {
  test("writes the diary, and refuses when the file changed on disk since it was loaded", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const opened = await h.caller.diary.open({ projectId: project.id })

    const saved = await h.caller.diary.save({
      projectId: project.id,
      relPath: opened.relPath,
      content: `${opened.content}First note.\n`,
      baseline: opened.baseline,
    })
    expect(await readFile(join(diaryDir(), "diary.md"), "utf8")).toBe(
      `${opened.content}First note.\n`,
    )

    await writeFile(join(diaryDir(), "diary.md"), "Changed by an agent, longer text.\n")
    await expect(
      h.caller.diary.save({
        projectId: project.id,
        relPath: opened.relPath,
        content: "My stale edit\n",
        baseline: saved.baseline,
      }),
    ).rejects.toThrow(/changed on disk/)
    expect(await readFile(join(diaryDir(), "diary.md"), "utf8")).toBe(
      "Changed by an agent, longer text.\n",
    )
  })
})
