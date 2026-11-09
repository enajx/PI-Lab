import { QueryClient } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../../../test/fakeTrpcClient"
import type { TaskRecord, TaskSource } from "./TasksWorkspace"

/**
 * Component test for the Tasks project picker in the top bar. The tRPC server
 * and the router are fakes (mocked); the e2e test covers the real app.
 */
const mocks = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }))

const { ScienceTasks } = await import("./ScienceTasks")

const PREF_KEY = "pi-lab.tasks.project"

/** A ready TODO.md source for one project. */
function source(projectId: string, projectName: string): TaskSource {
  return {
    projectId,
    projectName,
    state: "ready",
    relPath: "TODO.md",
    candidates: ["TODO.md"],
    revision: `sha256:${projectId}`,
    headings: [{ key: "heading:0", label: "TODO", path: ["TODO"] }],
    boardHeadings: [{ key: "heading:0", label: "TODO", path: ["TODO"] }],
  }
}

/** One planned task of a project. */
function task(projectId: string, projectName: string, title: string): TaskRecord {
  return {
    key: `${projectId}-${title}`,
    id: null,
    projectId,
    projectName,
    relPath: "TODO.md",
    revision: `sha256:${projectId}`,
    title,
    details: "",
    status: "planned",
    priority: null,
    labels: [],
    owner: null,
    heading: { key: "heading:0", label: "TODO", path: ["TODO"] },
    boardHeadingKey: "heading:0",
    source: { start: 0, end: 10, line: 2 },
  }
}

/** Mount the Tasks tab with two projects, one task each. */
function renderTasks(initialProjectId: string | undefined) {
  const client = createFakeTrpcClient({
    "science.tasks.list": () => ({
      tasks: [task("p1", "Alpha", "Build parser"), task("p2", "Beta", "Run benchmark")],
      sources: [source("p1", "Alpha"), source("p2", "Beta")],
    }),
    "agents.list": () => [],
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ScienceTasks initialProjectId={initialProjectId} />
    </AppProviders>,
  )
}

/** Titles of the task rows on screen. */
function rowTitles(): string[] {
  return screen.getAllByTestId("task-row").map((row) => row.textContent ?? "")
}

beforeEach(() => {
  window.localStorage.clear()
  mocks.navigate.mockReset()
})
afterEach(() => cleanup())

test("the top bar picker defaults to All projects and narrows the list to the chosen project", async () => {
  renderTasks(undefined)
  const header = screen.getByRole("banner")
  const select = (await within(header).findByTestId("tasks-project-select")) as HTMLSelectElement
  await waitFor(() => expect(screen.getAllByTestId("task-row")).toHaveLength(2))
  expect(select.value).toBe("")
  expect([...select.options].map((option) => option.text)).toEqual([
    "All projects",
    "Alpha",
    "Beta",
  ])

  fireEvent.change(select, { target: { value: "p2" } })
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/science/tasks",
    search: { projectId: "p2" },
    replace: true,
  })
  expect(window.localStorage.getItem(PREF_KEY)).toBe("p2")
  await waitFor(() => expect(rowTitles()).toEqual([expect.stringContaining("Run benchmark")]))

  // Kanban shows only the chosen project too, and a new task defaults to it.
  fireEvent.click(screen.getByRole("button", { name: "Kanban view" }))
  expect(screen.getAllByTestId("tasks-heading-project")).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: "New task" }))
  expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("p2")
})

test("arriving with ?projectId selects and remembers it; the picker then wins", async () => {
  renderTasks("p2")
  const select = (await screen.findByTestId("tasks-project-select")) as HTMLSelectElement
  await waitFor(() => expect(select.value).toBe("p2"))
  expect(rowTitles()).toEqual([expect.stringContaining("Run benchmark")])
  expect(window.localStorage.getItem(PREF_KEY)).toBe("p2")

  fireEvent.change(select, { target: { value: "" } })
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/science/tasks", search: {}, replace: true })
  expect(window.localStorage.getItem(PREF_KEY)).toBe("")
})

test("opens on the remembered project", async () => {
  window.localStorage.setItem(PREF_KEY, "p1")
  renderTasks(undefined)
  const select = (await screen.findByTestId("tasks-project-select")) as HTMLSelectElement
  await waitFor(() => expect(select.value).toBe("p1"))
  expect(rowTitles()).toEqual([expect.stringContaining("Build parser")])
})
