import { describe, expect, test } from "vitest"
import { parseTaskDocument, renderUpdatedTask, taskRevision } from "./markdown"

const project = { id: "p1", name: "Alpha" }

describe("parseTaskDocument", () => {
  test("parses ordinary and tagged tasks, headings, custom WIP, and indented details", () => {
    const content = [
      "# Queue",
      "",
      "- [ ] plain human task",
      "  Explanation stays with the task.",
      "  - supporting note",
      "",
      "## Active",
      "- [~] Experiment #id/task-7 #status/wip #priority/high #label/lab #label/gpu #owner/ada",
      "  More detail.",
      "- [x] Shipped",
      "",
    ].join("\n")

    const parsed = parseTaskDocument(content, project, "TODO.md")

    expect(parsed.revision).toBe(taskRevision(content))
    expect(parsed.tasks).toHaveLength(3)
    expect(parsed.tasks[0]).toMatchObject({
      id: null,
      title: "plain human task",
      details: "Explanation stays with the task.\n- supporting note",
      status: "planned",
      heading: { label: "Queue", path: ["Queue"] },
      source: { line: 3 },
    })
    expect(parsed.tasks[1]).toMatchObject({
      id: "task-7",
      title: "Experiment",
      details: "More detail.",
      status: "wip",
      priority: "high",
      labels: ["lab", "gpu"],
      owner: "ada",
      heading: { label: "Active", path: ["Queue", "Active"] },
    })
    expect(parsed.tasks[2]?.status).toBe("done")
  })

  test("selects one deterministic board depth and maps nested tasks to its section", () => {
    const content = [
      "# Root",
      "## Planned",
      "- [ ] Plan",
      "### Notes",
      "- [ ] Nested note",
      "## Doing",
      "- [~] Work",
      "## Done",
      "- [x] Ship",
      "",
    ].join("\n")
    const parsed = parseTaskDocument(content, project, "TODO.md")

    expect(parsed.boardHeadings.map((heading) => heading.label)).toEqual([
      "Planned",
      "Doing",
      "Done",
    ])
    const labels = new Map(parsed.boardHeadings.map((heading) => [heading.key, heading.label]))
    expect(
      parsed.tasks.map((task) => (task.boardHeadingKey ? labels.get(task.boardHeadingKey) : null)),
    ).toEqual(["Planned", "Planned", "Doing", "Done"])
  })

  test("chooses the most numerous repeated depth", () => {
    const content = ["# One", "## One A", "## One B", "# Two", "## Two A", "## Two B", ""].join(
      "\n",
    )
    const parsed = parseTaskDocument(content, project, "TODO.md")

    expect(parsed.boardHeadings.map((heading) => heading.label)).toEqual([
      "One A",
      "One B",
      "Two A",
      "Two B",
    ])
  })

  test("breaks equal heading-count ties toward the shallower depth", () => {
    const content = ["# One", "## One child", "# Two", "## Two child", ""].join("\n")
    const parsed = parseTaskDocument(content, project, "TODO.md")

    expect(parsed.boardHeadings.map((heading) => heading.label)).toEqual(["One", "Two"])
  })

  test("ignores checkbox-like lines inside fenced code blocks", () => {
    const parsed = parseTaskDocument(
      "```md\n- [ ] not a task\n```\n- [ ] real task\n",
      project,
      "TODO.md",
    )
    expect(parsed.tasks.map((task) => task.title)).toEqual(["real task"])
  })

  test("retains unknown hashtags as human title text", () => {
    const parsed = parseTaskDocument("- [ ] Read #paper #label/review\n", project, "TODO.md")
    expect(parsed.tasks[0]?.title).toBe("Read #paper")
    expect(parsed.tasks[0]?.labels).toEqual(["review"])
  })

  test("assigns a stable id only when a task is rewritten", () => {
    const content = "- [ ] untouched\n  detail\n"
    const parsed = parseTaskDocument(content, project, "TODO.md")
    const task = parsed.tasks[0]
    if (!task) throw new Error("fixture task missing")

    expect(task.id).toBeNull()
    const rewritten = renderUpdatedTask(
      task,
      {
        title: task.title,
        details: task.details,
        status: "wip",
        priority: null,
        labels: [],
        owner: null,
      },
      "\n",
    )
    expect(rewritten.block).toContain(`#id/${rewritten.id}`)
    expect(rewritten.block).toContain("#status/wip")
    expect(rewritten.block).toContain("  detail")
  })
})
