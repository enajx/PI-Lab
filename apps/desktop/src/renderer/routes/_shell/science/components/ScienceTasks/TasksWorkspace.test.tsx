import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, test, vi } from "vitest"
import { setInterfaceLanguage } from "../../../../../i18n/language"
import { type TaskRecord, type TaskSource, TasksWorkspace } from "./TasksWorkspace"

const sources: TaskSource[] = [
  {
    projectId: "p1",
    projectName: "Alpha",
    state: "ready",
    relPath: "TODO.md",
    candidates: ["TODO.md"],
    revision: "sha256:one",
    headings: [
      { key: "heading:0", label: "TODO", path: ["TODO"] },
      { key: "heading:10", label: "Implementation", path: ["TODO", "Implementation"] },
      { key: "heading:80", label: "Later", path: ["TODO", "Later"] },
    ],
    boardHeadings: [
      { key: "heading:10", label: "Implementation", path: ["TODO", "Implementation"] },
      { key: "heading:80", label: "Later", path: ["TODO", "Later"] },
    ],
  },
  {
    projectId: "p2",
    projectName: "Beta",
    state: "ready",
    relPath: "TODO.md",
    candidates: ["TODO.md"],
    revision: "sha256:two",
    headings: [{ key: "heading:40", label: "Experiments", path: ["TODO", "Experiments"] }],
    boardHeadings: [{ key: "heading:40", label: "Experiments", path: ["TODO", "Experiments"] }],
  },
  {
    projectId: "p3",
    projectName: "Gamma",
    state: "missing",
    relPath: null,
    candidates: [],
    revision: null,
    headings: [],
    boardHeadings: [],
  },
]

function task(overrides: Partial<TaskRecord> & Pick<TaskRecord, "key" | "title">): TaskRecord {
  return {
    id: null,
    projectId: "p1",
    projectName: "Alpha",
    relPath: "TODO.md",
    revision: "sha256:one",
    details: "",
    status: "planned",
    priority: null,
    labels: [],
    owner: null,
    heading: { key: "heading:10", label: "Implementation", path: ["TODO", "Implementation"] },
    boardHeadingKey: "heading:10",
    source: { start: 20, end: 50, line: 4 },
    ...overrides,
  }
}

function renderWorkspace(overrides: Partial<ComponentProps<typeof TasksWorkspace>> = {}) {
  const props: ComponentProps<typeof TasksWorkspace> = {
    tasks: [
      task({ key: "one", title: "Build parser", labels: ["markdown"], priority: "high" }),
      task({
        key: "two",
        title: "Run benchmark",
        projectId: "p2",
        projectName: "Beta",
        relPath: "TODO.md",
        revision: "sha256:two",
        status: "wip",
        heading: { key: "heading:40", label: "Experiments", path: ["TODO", "Experiments"] },
        boardHeadingKey: "heading:40",
        source: { start: 60, end: 90, line: 8 },
      }),
    ],
    sources,
    agents: [
      { id: "claude-code", label: "Claude Code" },
      { id: "codex", label: "Codex" },
    ],
    defaultAgentId: "codex",
    onCreate: vi.fn(async () => {}),
    onUpdate: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onMove: vi.fn(async () => {}),
    onRun: vi.fn(async () => {}),
    ...overrides,
  }
  const rendered = render(<TasksWorkspace {...props} />)
  return { props, ...rendered }
}

describe("TasksWorkspace", () => {
  afterEach(() => setInterfaceLanguage("en"))

  test("shows task controls in the selected interface language", () => {
    setInterfaceLanguage("es")
    renderWorkspace()
    expect(screen.getByText("Todos los proyectos")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Nueva tarea" })).toBeTruthy()
  })

  test("shows a known task validation error in the selected language", () => {
    setInterfaceLanguage("es")
    renderWorkspace({ error: "TODO Markdown changed since it was loaded" })
    expect(screen.getByText("El Markdown de TODO cambió desde que se cargó")).toBeTruthy()
  })

  test("defaults to a searchable all-project list", () => {
    renderWorkspace()
    expect(screen.getByTestId("tasks-list")).toBeTruthy()
    expect(screen.getAllByTestId("task-row")).toHaveLength(2)

    fireEvent.change(screen.getByTestId("tasks-search"), { target: { value: "rnbch" } })
    expect(screen.getAllByTestId("task-row")).toHaveLength(1)
    expect(screen.getByText("Run benchmark")).toBeTruthy()
  })

  test("hides completed tasks by default and reveals them with the show-done toggle", () => {
    renderWorkspace({
      tasks: [
        task({ key: "planned", title: "Still planned" }),
        task({ key: "complete", title: "Already complete", status: "done" }),
      ],
    })

    expect(screen.getByText("Still planned")).toBeTruthy()
    expect(screen.queryByText("Already complete")).toBeNull()
    expect(screen.getByRole("button", { name: "Show done" }).getAttribute("aria-pressed")).toBe(
      "false",
    )
    expect(
      screen.getByRole("button", { name: "Show done" }).querySelector(".lucide-eye"),
    ).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Show done" }))

    expect(screen.getByText("Already complete")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Hide done" }).getAttribute("aria-pressed")).toBe(
      "true",
    )
    expect(
      screen.getByRole("button", { name: "Hide done" }).querySelector(".lucide-eye-off"),
    ).toBeTruthy()
  })

  test("optionally clusters the list project-first by nearest Markdown heading", () => {
    renderWorkspace({
      tasks: [
        task({ key: "one", title: "Build parser" }),
        task({
          key: "two",
          title: "Write notes",
          heading: { key: "heading:80", label: "Later", path: ["TODO", "Later"] },
          boardHeadingKey: "heading:80",
          source: { start: 90, end: 110, line: 10 },
        }),
        task({
          key: "three",
          title: "Loose task",
          heading: null,
          boardHeadingKey: null,
          source: { start: 120, end: 140, line: 12 },
        }),
        task({
          key: "four",
          title: "Run benchmark",
          projectId: "p2",
          projectName: "Beta",
          relPath: "TODO.md",
          revision: "sha256:two",
          heading: { key: "heading:40", label: "Experiments", path: ["TODO", "Experiments"] },
          boardHeadingKey: "heading:40",
          source: { start: 60, end: 90, line: 8 },
        }),
      ],
    })

    expect(screen.getByTestId("tasks-list")).toBeTruthy()
    expect(screen.queryByTestId("tasks-heading-list")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Group by headings" }))

    expect(screen.getByTestId("tasks-heading-list")).toBeTruthy()
    expect(screen.getAllByTestId("task-list-project").map((node) => node.textContent)).toEqual([
      expect.stringContaining("Alpha"),
      expect.stringContaining("Beta"),
    ])
    expect(screen.getAllByTestId("task-list-heading").map((node) => node.textContent)).toEqual([
      "TODO / Implementation",
      "TODO / Later",
      "Ungrouped",
      "TODO / Experiments",
    ])
    expect(screen.getAllByTestId("task-row").map((node) => node.textContent)).toEqual([
      expect.stringContaining("Build parser"),
      expect.stringContaining("Write notes"),
      expect.stringContaining("Loose task"),
      expect.stringContaining("Run benchmark"),
    ])

    fireEvent.click(screen.getByRole("button", { name: "No grouping" }))
    expect(screen.getByTestId("tasks-list")).toBeTruthy()
  })

  test("switches between heading and status-grouped Kanban views", () => {
    renderWorkspace()
    const toolbarControls = screen.getByTestId("tasks-toolbar-controls")
    expect(screen.queryByText("Group by")).toBeNull()
    expect(within(toolbarControls).getByRole("group", { name: "Grouping" })).toBeTruthy()
    expect(within(toolbarControls).getByRole("button", { name: "List view" })).toBeTruthy()
    expect(within(toolbarControls).getByRole("button", { name: "Kanban view" })).toBeTruthy()
    expect(within(toolbarControls).getByRole("button", { name: "No grouping" })).toBeTruthy()
    expect(within(toolbarControls).getByRole("button", { name: "Group by headings" })).toBeTruthy()
    expect(
      within(toolbarControls).getByRole("button", { name: "No grouping" }).getAttribute("title"),
    ).toBe("Show all tasks in one flat list")
    expect(
      within(toolbarControls)
        .getByRole("button", { name: "Group by headings" })
        .getAttribute("title"),
    ).toBe("Organize tasks using the TODO Markdown headings")
    expect(
      within(toolbarControls).getByRole("button", { name: "List view" }).getAttribute("title"),
    ).toBe("Show tasks as compact rows")
    expect(
      within(toolbarControls).getByRole("button", { name: "Kanban view" }).getAttribute("title"),
    ).toBe("Show tasks as draggable columns")

    fireEvent.click(screen.getByRole("button", { name: "Kanban view" }))
    expect(screen.getByTestId("tasks-heading-board")).toBeTruthy()
    expect(screen.getByText("TODO / Implementation")).toBeTruthy()
    expect(screen.getByText("TODO / Experiments")).toBeTruthy()
    expect(screen.getByText("TODO / Later")).toBeTruthy()
    expect(screen.queryByRole("heading", { name: /^TODO$/ })).toBeNull()

    expect(within(toolbarControls).getByRole("button", { name: "Group by Kanban" })).toBeTruthy()
    expect(
      within(toolbarControls)
        .getByRole("button", { name: "Group by Kanban" })
        .getAttribute("title"),
    ).toBe("Organize tasks into Todo, In Progress, and Done")
    fireEvent.click(screen.getByRole("button", { name: "Group by Kanban" }))
    expect(screen.getByTestId("tasks-status-board")).toBeTruthy()
    for (const heading of ["Todo", "In Progress", "Done"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeTruthy()
    }
  })

  test("limits large heading boards to four selected columns and supports hide and restore", () => {
    const alphaSource = sources.find((source) => source.projectId === "p1")
    if (!alphaSource) throw new Error("Alpha source fixture missing")
    const headingSource: TaskSource = {
      ...alphaSource,
      headings: [
        { key: "h1", label: "One", path: ["TODO", "One"] },
        { key: "h2", label: "Two", path: ["TODO", "Two"] },
        { key: "h3", label: "Three", path: ["TODO", "Three"] },
        { key: "h4", label: "Four", path: ["TODO", "Four"] },
        { key: "h5", label: "Five", path: ["TODO", "Five"] },
        { key: "h6", label: "Six", path: ["TODO", "Six"] },
      ],
      boardHeadings: [
        { key: "h1", label: "One", path: ["TODO", "One"] },
        { key: "h2", label: "Two", path: ["TODO", "Two"] },
        { key: "h3", label: "Three", path: ["TODO", "Three"] },
        { key: "h4", label: "Four", path: ["TODO", "Four"] },
        { key: "h5", label: "Five", path: ["TODO", "Five"] },
        { key: "h6", label: "Six", path: ["TODO", "Six"] },
      ],
    }
    renderWorkspace({
      sources: [headingSource],
      tasks: [
        task({
          key: "hidden-five",
          title: "Task in hidden heading",
          heading: { key: "h5", label: "Five", path: ["TODO", "Five"] },
          boardHeadingKey: "h5",
        }),
      ],
    })
    fireEvent.click(screen.getByRole("button", { name: "Kanban view" }))

    const project = screen.getByTestId("tasks-heading-project")
    expect(within(project).getAllByTestId("board-column")).toHaveLength(4)
    expect(within(project).queryByRole("group", { name: "TODO / Five" })).toBeNull()
    const fullPicker = within(project).getByRole("button", {
      name: "Restore hidden columns for Alpha (2 hidden, 1 task in hidden columns)",
    })
    expect(fullPicker.querySelector(".lucide-eye-off")).toBeTruthy()
    fireEvent.click(fullPicker)
    expect(
      (
        within(project).getByRole("menuitemcheckbox", {
          name: "Show TODO / Five column (1 task)",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    fireEvent.click(fullPicker)

    fireEvent.click(within(project).getByRole("button", { name: "Hide TODO / One column" }))
    expect(within(project).getAllByTestId("board-column")).toHaveLength(3)

    fireEvent.click(
      within(project).getByRole("button", {
        name: "Restore hidden columns for Alpha (3 hidden, 1 task in hidden columns)",
      }),
    )
    fireEvent.click(
      within(project).getByRole("menuitemcheckbox", {
        name: "Show TODO / Five column (1 task)",
      }),
    )

    expect(within(project).queryByRole("group", { name: "TODO / One" })).toBeNull()
    expect(within(project).getByRole("group", { name: "TODO / Five" })).toBeTruthy()
  })

  test("always shows three Kanban lanes and maps existing statuses without rewriting them", () => {
    const onMove = vi.fn(async () => {})
    const planned = task({ key: "planned-stage", title: "Plain todo", status: "planned" })
    const backlog = task({ key: "backlog-stage", title: "Legacy backlog", status: "backlog" })
    const inProgress = task({ key: "wip-stage", title: "Active work", status: "wip" })
    const done = task({ key: "done-stage", title: "Finished work", status: "done" })
    renderWorkspace({ tasks: [planned, backlog, inProgress, done], onMove })
    fireEvent.click(screen.getByRole("button", { name: "Show done" }))
    fireEvent.click(screen.getByRole("button", { name: "Kanban view" }))
    fireEvent.click(screen.getByRole("button", { name: "Group by Kanban" }))

    const todoLane = screen.getByRole("group", { name: "Todo" })
    const progressLane = screen.getByRole("group", { name: "In Progress" })
    const doneLane = screen.getByRole("group", { name: "Done" })
    expect(within(todoLane).getByText("Plain todo")).toBeTruthy()
    expect(within(todoLane).getByText("Legacy backlog")).toBeTruthy()
    expect(within(progressLane).getByText("Active work")).toBeTruthy()
    expect(within(doneLane).getByText("Finished work")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /stage columns/i })).toBeNull()
    expect(screen.queryByRole("button", { name: "Hide Todo column" })).toBeNull()

    fireEvent.dragStart(within(progressLane).getByTestId("task-card"))
    fireEvent.dragOver(todoLane)
    fireEvent.drop(todoLane)
    expect(onMove).toHaveBeenCalledWith(inProgress, { kind: "status", status: "planned" })
  })

  test("renders all three Kanban lanes when there are no tasks", () => {
    renderWorkspace({ tasks: [] })
    fireEvent.click(screen.getByRole("button", { name: "Kanban view" }))
    fireEvent.click(screen.getByRole("button", { name: "Group by Kanban" }))

    expect(screen.queryByTestId("tasks-empty")).toBeNull()
    expect(screen.getByTestId("tasks-status-board")).toBeTruthy()
    for (const heading of ["Todo", "In Progress", "Done"]) {
      expect(screen.getByRole("group", { name: heading })).toBeTruthy()
    }
  })

  test("keeps heading selections when Markdown edits shift revision-local heading keys", () => {
    const alphaSource = sources.find((source) => source.projectId === "p1")
    if (!alphaSource) throw new Error("Alpha source fixture missing")
    const sourceBefore: TaskSource = {
      ...alphaSource,
      headings: [
        { key: "heading:10", label: "One", path: ["TODO", "One"] },
        { key: "heading:20", label: "Two", path: ["TODO", "Two"] },
      ],
      boardHeadings: [
        { key: "heading:10", label: "One", path: ["TODO", "One"] },
        { key: "heading:20", label: "Two", path: ["TODO", "Two"] },
      ],
    }
    const rendered = renderWorkspace({
      sources: [sourceBefore],
      tasks: [
        task({
          key: "stable-task",
          title: "Stable task",
          heading: { key: "heading:20", label: "Two", path: ["TODO", "Two"] },
          boardHeadingKey: "heading:20",
        }),
      ],
    })
    fireEvent.click(screen.getByRole("button", { name: "Kanban view" }))
    fireEvent.click(screen.getByRole("button", { name: "Hide TODO / One column" }))

    const sourceAfter: TaskSource = {
      ...sourceBefore,
      headings: [
        { key: "heading:100", label: "One", path: ["TODO", "One"] },
        { key: "heading:200", label: "Two", path: ["TODO", "Two"] },
      ],
      boardHeadings: [
        { key: "heading:100", label: "One", path: ["TODO", "One"] },
        { key: "heading:200", label: "Two", path: ["TODO", "Two"] },
      ],
    }
    rendered.rerender(
      <TasksWorkspace
        {...rendered.props}
        sources={[sourceAfter]}
        tasks={[
          task({
            key: "stable-task",
            title: "Stable task",
            heading: { key: "heading:200", label: "Two", path: ["TODO", "Two"] },
            boardHeadingKey: "heading:200",
          }),
        ]}
      />,
    )

    expect(screen.queryByRole("group", { name: "TODO / One" })).toBeNull()
    expect(screen.getByRole("group", { name: "TODO / Two" })).toBeTruthy()
    expect(screen.getByText("Stable task")).toBeTruthy()
  })

  test("creates a normal task in a missing project's canonical TODO.md", async () => {
    const onCreate = vi.fn(async () => {})
    renderWorkspace({ onCreate })
    fireEvent.click(screen.getByRole("button", { name: "New task" }))

    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "p3" } })
    expect((screen.getByLabelText("TODO file") as HTMLSelectElement).value).toBe("TODO.md")
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Write results" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        "p3",
        "TODO.md",
        expect.objectContaining({ title: "Write results", status: "planned" }),
      ),
    )
  })

  test("runs the configured default agent with an editable prompt", async () => {
    const onRun = vi.fn(async () => {})
    renderWorkspace({ onRun })
    fireEvent.click(screen.getByRole("button", { name: "Run agent for Build parser" }))

    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("codex")
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Custom task prompt" } })
    fireEvent.click(screen.getByRole("button", { name: "Run agent" }))

    await waitFor(() =>
      expect(onRun).toHaveBeenCalledWith(
        expect.objectContaining({ key: "one" }),
        "codex",
        "Custom task prompt",
      ),
    )
  })
})
