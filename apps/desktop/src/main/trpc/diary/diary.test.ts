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
  test("shows today's heading for a missing diary but does not create the file", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const today = localDateHeading(new Date())

    const opened = await h.caller.diary.open({ projectId: project.id })

    expect(opened.relPath).toBe("md/research-diary/diary.md")
    expect(opened.content).toBe(`${today}\n\n`)
    expect(opened.baseline.exists).toBe(false)
    await expect(stat(join(diaryDir(), "diary.md"))).rejects.toThrow()
  })

  test("shows today's heading at the top below the title, once, without writing it", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const today = localDateHeading(new Date())
    await mkdir(diaryDir(), { recursive: true })
    const onDisk = "# My diary\n\n## 2020-01-02\n\nOld entry.\n"
    await writeFile(join(diaryDir(), "diary.md"), onDisk)

    await h.caller.diary.open({ projectId: project.id })
    const again = await h.caller.diary.open({ projectId: project.id })

    expect(again.content).toBe(`# My diary\n\n${today}\n\n## 2020-01-02\n\nOld entry.\n`)
    expect(await readFile(join(diaryDir(), "diary.md"), "utf8")).toBe(onDisk)
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
  test("MyST shows a title front matter on diary.md once, renames nothing, and writes nothing", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const today = localDateHeading(new Date())
    await mkdir(diaryDir(), { recursive: true })
    await writeFile(join(diaryDir(), "diary.md"), `${today}\n\nEntry.\n`)

    await h.caller.settings.updateEditor({ researchDiaryFormat: "myst" })
    await h.caller.diary.open({ projectId: project.id })
    const myst = await h.caller.diary.open({ projectId: project.id })

    expect(myst.relPath).toBe("md/research-diary/diary.md")
    expect(myst.content).toBe(`---\ntitle: Research diary\n---\n\n${today}\n\nEntry.\n`)
    expect(await readFile(join(diaryDir(), "diary.md"), "utf8")).toBe(`${today}\n\nEntry.\n`)
  })

  test("MyST keeps an existing front matter as it is", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const today = localDateHeading(new Date())
    await mkdir(diaryDir(), { recursive: true })
    await writeFile(join(diaryDir(), "diary.qmd"), `---\ntitle: Lab notes\n---\n\n${today}\n`)

    await h.caller.settings.updateEditor({ researchDiaryFormat: "myst" })
    const myst = await h.caller.diary.open({ projectId: project.id })

    expect(myst.relPath).toBe("md/research-diary/diary.md")
    expect(myst.content).toBe(`---\ntitle: Lab notes\n---\n\n${today}\n`)
    await expect(stat(join(diaryDir(), "diary.qmd"))).rejects.toThrow()
  })

  test("MyST with Windows line endings and blank lines before the front matter: no second front matter, heading below it", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const today = localDateHeading(new Date())
    await mkdir(diaryDir(), { recursive: true })
    await writeFile(
      join(diaryDir(), "diary.md"),
      "\r\n---\r\ntitle: Lab notes\r\n---\r\n\r\n# Diary\r\n\r\n## 2020-01-01\r\n\r\nOld.\r\n",
    )

    await h.caller.settings.updateEditor({ researchDiaryFormat: "myst" })
    const myst = await h.caller.diary.open({ projectId: project.id })

    expect(myst.content).toBe(
      `\r\n---\r\ntitle: Lab notes\r\n---\r\n\r\n# Diary\r\n\r\n${today}\r\n\r\n## 2020-01-01\r\n\r\nOld.\r\n`,
    )
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

  test("drops day headings with nothing under them, keeping the front matter and the title", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    const opened = await h.caller.diary.open({ projectId: project.id })
    const content = [
      "---",
      "title: Lab notes",
      "---",
      "",
      "# Diary",
      "",
      "## 2026-11-12",
      "",
      "## 2026-11-11",
      "",
      "",
      "## 2026-11-10",
      "",
      "Entry.",
      "",
      "### Details",
      "",
      "## 2026-11-09",
      "",
    ].join("\n")

    await h.caller.diary.save({
      projectId: project.id,
      relPath: opened.relPath,
      content,
      baseline: opened.baseline,
    })

    expect(await readFile(join(diaryDir(), "diary.md"), "utf8")).toBe(
      "---\ntitle: Lab notes\n---\n\n# Diary\n\n## 2026-11-10\n\nEntry.\n\n### Details\n",
    )
  })
})
