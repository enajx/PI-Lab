import { mkdir, readFile, writeFile } from "node:fs/promises"
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
  test("remembers a clear root TODO discovered after the project was added", async () => {
    const project = await h.caller.projects.open({ path: h.repoDir })
    expect(project.taskRelPath).toBeNull()
    await writeFile(join(h.repoDir, "Work-TODO.md"), "# Work\n- [ ] New task\n")

    const listing = await h.caller.science.tasks.list()

    expect(listing.sources.find((source) => source.projectId === project.id)?.relPath).toBe(
      "Work-TODO.md",
    )
    expect((await h.caller.projects.get({ id: project.id })).taskRelPath).toBe("Work-TODO.md")
  })

  test("creates tasks in a selected nested Markdown file with a different name", async () => {
    await mkdir(join(h.repoDir, "notes"))
    await writeFile(join(h.repoDir, "notes", "Work.md"), "# Work\n- [ ] Existing nested\n")
    await writeFile(join(h.repoDir, "TODO.md"), "# Old\n- [ ] Old task\n")
    const project = await h.caller.projects.open({ path: h.repoDir })
    await h.caller.projects.setDocumentPath({
      id: project.id,
      kind: "tasks",
      relPath: "notes/Work.md",
    })

    const listing = await h.caller.science.tasks.list()
    const source = listing.sources.find((candidate) => candidate.projectId === project.id)
    if (!source?.revision) throw new Error("selected source missing")
    expect(source.relPath).toBe("notes/Work.md")
    expect(listing.tasks.map((task) => task.title)).toEqual(["Existing nested"])

    await h.caller.science.tasks.create({
      projectId: project.id,
      relPath: "notes/Work.md",
      expectedRevision: source.revision,
      title: "Added nested",
      details: "",
      status: "planned",
      priority: null,
      labels: [],
      owner: null,
    })
    expect(await readFile(join(h.repoDir, "notes", "Work.md"), "utf8")).toContain("Added nested")
    expect(await readFile(join(h.repoDir, "TODO.md"), "utf8")).toBe("# Old\n- [ ] Old task\n")
  })

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
