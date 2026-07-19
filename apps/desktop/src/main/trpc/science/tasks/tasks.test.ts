import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, type Harness } from "../../testHarness"

let h: Harness

beforeEach(async () => {
  h = await createHarness()
})

afterEach(async () => {
  await h.dispose()
})

describe("science.tasks router", () => {
  test("lists Markdown tasks and carries revisions through create and update", async () => {
    await writeFile(join(h.repoDir, "TODO.md"), "# Work\n- [ ] Existing\n")
    const project = await h.caller.projects.open({ path: h.repoDir })

    const first = await h.caller.science.tasks.list()
    const source = first.sources.find((candidate) => candidate.projectId === project.id)
    if (!source?.revision) throw new Error("ready source missing")
    expect(source.headings).toEqual([{ key: "heading:0", label: "Work", path: ["Work"] }])
    expect(source.boardHeadings).toEqual([{ key: "heading:0", label: "Work", path: ["Work"] }])
    expect(first.tasks.map((task) => task.title)).toEqual(["Existing"])

    const created = await h.caller.science.tasks.create({
      projectId: project.id,
      relPath: "TODO.md",
      expectedRevision: source.revision,
      title: "Created through tRPC",
      details: "Router integration detail.",
      status: "backlog",
      priority: null,
      labels: ["integration"],
      owner: null,
    })
    const createdId = created.task.id
    if (!createdId) throw new Error("created id missing")

    const updated = await h.caller.science.tasks.update({
      projectId: project.id,
      relPath: "TODO.md",
      expectedRevision: created.revision,
      selector: { id: createdId },
      status: "wip",
    })
    expect(updated.task.status).toBe("wip")
    const sourceText = await readFile(join(h.repoDir, "TODO.md"), "utf8")
    expect(sourceText).toContain("[~] Created through tRPC")
    expect(sourceText).toContain("#label/integration")
  })

  test("returns a tRPC conflict for an out-of-band edit", async () => {
    const path = join(h.repoDir, "TODO.md")
    await writeFile(path, "- [ ] Initial\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    const listed = await h.caller.science.tasks.list()
    const source = listed.sources.find((candidate) => candidate.projectId === project.id)
    const task = listed.tasks.find((candidate) => candidate.projectId === project.id)
    if (!source?.revision || !task) throw new Error("fixture listing missing")

    await writeFile(path, "- [ ] Edited by an agent\n")
    await expect(
      h.caller.science.tasks.update({
        projectId: project.id,
        relPath: "TODO.md",
        expectedRevision: source.revision,
        selector: { sourceStart: task.source.start },
        title: "PI Lab edit",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(readFile(path, "utf8")).resolves.toBe("- [ ] Edited by an agent\n")
  })
})
