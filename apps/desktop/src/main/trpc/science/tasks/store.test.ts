import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Project } from "@pi-lab/local-db"
import { afterEach, describe, expect, test } from "vitest"
import { taskRevision } from "./markdown"
import {
  createTask,
  deleteTask,
  discoverTaskFile,
  listProjectTasks,
  moveTask,
  setBeforeTaskRevisionCheckForTest,
  updateTask,
} from "./store"

const roots: string[] = []

afterEach(async () => {
  setBeforeTaskRevisionCheckForTest(null)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(name: string): Promise<{ root: string; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), "pi-lab-tasks-"))
  roots.push(root)
  return {
    root,
    project: {
      id: `project-${name}`,
      name,
      repoPath: root,
      defaultBranch: "main",
      color: null,
      thumbnail: null,
      agentConfig: null,
      sortIndex: 0,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
    },
  }
}

describe("TODO Markdown discovery and aggregation", () => {
  test("finds case-insensitive root Markdown names and prefers one canonical name", async () => {
    const { root } = await fixture("Alpha")
    await writeFile(join(root, "project-todo-notes.md"), "- [ ] notes\n")
    await writeFile(join(root, "ToDo.MD"), "- [ ] canonical\n")
    await writeFile(join(root, "nested-todo.md.txt"), "ignored\n")

    await expect(discoverTaskFile(root)).resolves.toEqual({
      state: "ready",
      relPath: "ToDo.MD",
      candidates: ["project-todo-notes.md", "ToDo.MD"],
    })
  })

  test("surfaces ambiguous duplicates rather than choosing silently", async () => {
    const { root } = await fixture("Alpha")
    await writeFile(join(root, "TODO.md"), "")
    await writeFile(join(root, "TODOs.md"), "")

    const result = await discoverTaskFile(root)
    expect(result.state).toBe("ambiguous")
    expect(result.relPath).toBeNull()
    expect(result.candidates).toEqual(["TODO.md", "TODOs.md"])
  })

  test("aggregates ready tasks and reports missing sources for all projects", async () => {
    const alpha = await fixture("Alpha")
    const beta = await fixture("Beta")
    await writeFile(join(alpha.root, "TODO.md"), "# Work\n- [ ] Alpha task\n")

    const listing = await listProjectTasks([beta.project, alpha.project])

    expect(listing.sources.map((source) => [source.projectName, source.state])).toEqual([
      ["Alpha", "ready"],
      ["Beta", "missing"],
    ])
    expect(listing.sources[0]?.headings).toEqual([
      { key: "heading:0", label: "Work", path: ["Work"] },
    ])
    expect(listing.sources[0]?.boardHeadings).toEqual([
      { key: "heading:0", label: "Work", path: ["Work"] },
    ])
    expect(listing.sources[1]?.headings).toEqual([])
    expect(listing.sources[1]?.boardHeadings).toEqual([])
    expect(listing.tasks).toHaveLength(1)
    expect(listing.tasks[0]).toMatchObject({
      projectId: alpha.project.id,
      projectName: "Alpha",
      relPath: "TODO.md",
      title: "Alpha task",
      id: null,
    })
  })
})

describe("surgical task mutations", () => {
  test("updates one ordinary task, lazily assigning an id while preserving surrounding bytes", async () => {
    const { root, project } = await fixture("Alpha")
    const original = "Preamble\r\n\r\n- [ ] Human task\r\n  detail\r\n\r\nFooter stays exact\r\n"
    await writeFile(join(root, "TODO.md"), original)
    const revision = taskRevision(original)

    const result = await updateTask({
      project,
      relPath: "TODO.md",
      expectedRevision: revision,
      selector: { sourceStart: original.indexOf("- [ ]") },
      patch: { status: "wip" },
    })
    const next = await readFile(join(root, "TODO.md"), "utf8")

    expect(result.task.id).not.toBeNull()
    expect(result.task.status).toBe("wip")
    expect(next.startsWith("Preamble\r\n\r\n")).toBe(true)
    expect(next.endsWith("\r\n\r\nFooter stays exact\r\n")).toBe(true)
    expect(next).toContain("- [~] Human task")
    expect(next).toContain("  detail\r\n")
  })

  test("rejects a stale expected revision without writing", async () => {
    const { root, project } = await fixture("Alpha")
    const content = "- [ ] First\n"
    const path = join(root, "TODO.md")
    await writeFile(path, content)

    await expect(
      updateTask({
        project,
        relPath: "TODO.md",
        expectedRevision: taskRevision("older"),
        selector: { sourceStart: 0 },
        patch: { title: "Changed" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(readFile(path, "utf8")).resolves.toBe(content)
  })

  test("creates in a heading, moves the complete block by heading and status, then deletes it", async () => {
    const { root, project } = await fixture("Alpha")
    const initial = "# Planned\n\n# Doing\n\n# Done\n"
    const path = join(root, "TODO.md")
    await writeFile(path, initial)
    const parsedListing = await listProjectTasks([project])
    const source = parsedListing.sources[0]
    if (!source?.revision) throw new Error("source missing")

    // Empty headings are parser-visible even though no task cards exist yet.
    const plannedHeading = "heading:0"
    const created = await createTask({
      project,
      relPath: "TODO.md",
      expectedRevision: source.revision,
      headingKey: plannedHeading,
      fields: {
        title: "Run assay",
        details: "Keep this detail.",
        status: "planned",
        priority: "high",
        labels: ["lab"],
        owner: null,
      },
    })
    expect(created.task.heading?.label).toBe("Planned")
    const createdId = created.task.id
    if (!createdId) throw new Error("created task id missing")
    expect(createdId).toMatch(/^[a-f0-9]{12}$/)

    const afterCreate = await readFile(path, "utf8")
    const doingOffset = afterCreate.indexOf("# Doing")
    const movedHeading = await moveTask({
      project,
      relPath: "TODO.md",
      expectedRevision: created.revision,
      selector: { id: createdId },
      destination: { mode: "heading", headingKey: `heading:${doingOffset}` },
    })
    expect(movedHeading.task.heading?.label).toBe("Doing")
    expect(movedHeading.task.details).toBe("Keep this detail.")
    const movedHeadingId = movedHeading.task.id
    if (!movedHeadingId) throw new Error("moved task id missing")

    const movedStatus = await moveTask({
      project,
      relPath: "TODO.md",
      expectedRevision: movedHeading.revision,
      selector: { id: movedHeadingId },
      destination: { mode: "status", status: "done" },
    })
    expect(movedStatus.task.status).toBe("done")
    expect(await readFile(path, "utf8")).toContain("[x] Run assay")
    const movedStatusId = movedStatus.task.id
    if (!movedStatusId) throw new Error("status-moved task id missing")

    const deleted = await deleteTask({
      project,
      relPath: "TODO.md",
      expectedRevision: movedStatus.revision,
      selector: { id: movedStatusId },
    })
    const final = await readFile(path, "utf8")
    expect(final).not.toContain("Run assay")
    expect(deleted.revision).toBe(taskRevision(final))
    expect(final).toContain("# Planned")
    expect(final).toContain("# Doing")
    expect(final).toContain("# Done")
  })

  test("keeps empty headings in source metadata after their last task moves away", async () => {
    const { root, project } = await fixture("Alpha")
    await writeFile(join(root, "TODO.md"), "# First\n- [ ] Only task\n\n# Second\n")

    const before = await listProjectTasks([project])
    const source = before.sources[0]
    const task = before.tasks[0]
    if (!source?.revision || !task) throw new Error("fixture listing missing")
    const second = source.headings.find((heading) => heading.label === "Second")
    if (!second) throw new Error("empty target heading missing")

    await moveTask({
      project,
      relPath: "TODO.md",
      expectedRevision: source.revision,
      selector: { sourceStart: task.source.start },
      destination: { mode: "heading", headingKey: second.key },
    })
    const after = await listProjectTasks([project])

    expect(after.sources[0]?.headings.map((heading) => heading.label)).toEqual(["First", "Second"])
    expect(after.sources[0]?.boardHeadings.map((heading) => heading.label)).toEqual([
      "First",
      "Second",
    ])
    expect(after.tasks[0]?.heading?.label).toBe("Second")
    expect(after.tasks[0]?.boardHeadingKey).toBe(after.sources[0]?.boardHeadings[1]?.key)
  })

  test("drops into direct heading content before descendants and after direct tasks", async () => {
    const { root, project } = await fixture("Alpha")
    const initial = [
      "# Project",
      "## Planned",
      "- [ ] Existing",
      "### Notes",
      "Human notes.",
      "## Doing",
      "- [~] Move me",
      "",
    ].join("\n")
    const path = join(root, "TODO.md")
    await writeFile(path, initial)
    const before = await listProjectTasks([project])
    const source = before.sources[0]
    const moving = before.tasks.find((task) => task.title === "Move me")
    const planned = source?.boardHeadings.find((heading) => heading.label === "Planned")
    if (!source?.revision || !moving || !planned) throw new Error("fixture listing missing")

    const moved = await moveTask({
      project,
      relPath: "TODO.md",
      expectedRevision: source.revision,
      selector: { sourceStart: moving.source.start },
      destination: { mode: "heading", headingKey: planned.key },
    })
    const next = await readFile(path, "utf8")

    expect(next.indexOf("Existing")).toBeLessThan(next.indexOf("Move me"))
    expect(next.indexOf("Move me")).toBeLessThan(next.indexOf("### Notes"))
    expect(moved.task.heading?.label).toBe("Planned")
    expect(moved.task.boardHeadingKey).toBe(planned.key)

    const created = await createTask({
      project,
      relPath: "TODO.md",
      expectedRevision: moved.revision,
      headingKey: planned.key,
      fields: {
        title: "Create here",
        details: "",
        status: "planned",
        priority: null,
        labels: [],
        owner: null,
      },
    })
    const afterCreate = await readFile(path, "utf8")
    expect(afterCreate.indexOf("Move me")).toBeLessThan(afterCreate.indexOf("Create here"))
    expect(afterCreate.indexOf("Create here")).toBeLessThan(afterCreate.indexOf("### Notes"))
    expect(created.task.heading?.label).toBe("Planned")
    expect(created.task.boardHeadingKey).toBe(planned.key)
  })

  test("creates a missing TODO.md only when the expected revision is null", async () => {
    const { root, project } = await fixture("Alpha")
    const created = await createTask({
      project,
      relPath: "TODO.md",
      expectedRevision: null,
      fields: {
        title: "First task",
        details: "",
        status: "backlog",
        priority: null,
        labels: [],
        owner: null,
      },
    })
    expect(created.task.status).toBe("backlog")
    await expect(readFile(join(root, "TODO.md"), "utf8")).resolves.toContain("#status/backlog")
  })

  test("rejects and preserves an edit made after rendering but before atomic rename", async () => {
    const { root, project } = await fixture("Alpha")
    const path = join(root, "TODO.md")
    const external = "- [ ] Created concurrently by an agent\n"
    setBeforeTaskRevisionCheckForTest(async (target) => {
      expect(target).toBe(path)
      await writeFile(target, external)
    })

    await expect(
      createTask({
        project,
        relPath: "TODO.md",
        expectedRevision: null,
        fields: {
          title: "PI Lab task",
          details: "",
          status: "planned",
          priority: null,
          labels: [],
          owner: null,
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })

    await expect(readFile(path, "utf8")).resolves.toBe(external)
    const names = await readdir(root)
    expect(names.some((name) => name.includes(".pi-lab-") && name.endsWith(".tmp"))).toBe(false)
  })
})
