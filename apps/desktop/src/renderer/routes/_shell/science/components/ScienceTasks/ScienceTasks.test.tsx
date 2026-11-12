import { QueryClient } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../../../test/fakeTrpcClient"
import type { FocusSessionRequest } from "../ScienceSessionPanel"
import type { TaskRecord, TaskSource } from "./TasksWorkspace"

/**
 * Component test for the Tasks project picker in the top bar. The tRPC server
 * and the router are fakes (mocked); the e2e test covers the real app.
 */
const mocks = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }))

// xterm needs layout APIs jsdom lacks, so the terminal is a stub that shows its session id.
vi.mock("../../../../../Terminal", () => ({
  Terminal: ({ inputKind, sessionId }: { inputKind: "agent" | "terminal"; sessionId?: string }) => (
    <div data-testid="terminal" data-input-kind={inputKind} data-session-id={sessionId} />
  ),
}))

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
function renderTasks(initialProjectId: string | undefined, focusSession?: FocusSessionRequest) {
  const client = createFakeTrpcClient({
    "science.tasks.list": () => ({
      tasks: [task("p1", "Alpha", "Build parser"), task("p2", "Beta", "Run benchmark")],
      sources: [source("p1", "Alpha"), source("p2", "Beta")],
    }),
    "agents.list": () => [],
    "workspaces.ensureMain": () => ({ id: "ws-2" }),
    "settings.get": () => ({ agents: { defaultAgentId: "claude-code" } }),
    "agents.projectChoice": () => ({ agentId: null, storage: "app" }),
    "terminal.list": () => [{ id: "agent-9", alive: true }],
    "files.tree": () => [],
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ScienceTasks initialProjectId={initialProjectId} focusSession={focusSession ?? null} />
    </AppProviders>,
  )
}

/** Text of the Kanban task cards on screen (the default view). */
function cardTitles(): string[] {
  return screen.getAllByTestId("task-card").map((card) => card.textContent ?? "")
}

beforeEach(() => {
  window.localStorage.clear()
  mocks.navigate.mockReset()
})
afterEach(() => cleanup())

test("the top bar picker defaults to All projects and narrows the tasks to the chosen project", async () => {
  renderTasks(undefined)
  const header = screen.getByRole("banner")
  const select = (await within(header).findByTestId("tasks-project-select")) as HTMLButtonElement
  await waitFor(() => expect(screen.getAllByTestId("task-card")).toHaveLength(2))
  expect(select.value).toBe("")
  fireEvent.click(select)
  const list = screen.getByRole("listbox", { name: "Project filter" })
  expect(
    within(list)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["All projects", "Alpha", "Beta"])

  fireEvent.click(within(list).getByRole("option", { name: "Beta" }))
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/science/tasks",
    search: { projectId: "p2" },
    replace: true,
  })
  expect(window.localStorage.getItem(PREF_KEY)).toBe("p2")
  await waitFor(() => expect(cardTitles()).toEqual([expect.stringContaining("Run benchmark")]))

  // Kanban shows only the chosen project, and a new task defaults to it.
  expect(screen.getAllByTestId("tasks-heading-project")).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: "New task" }))
  expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("p2")
})

test("arriving with ?projectId selects and remembers it; the picker then wins", async () => {
  renderTasks("p2")
  const select = (await screen.findByTestId("tasks-project-select")) as HTMLButtonElement
  await waitFor(() => expect(select.value).toBe("p2"))
  expect(cardTitles()).toEqual([expect.stringContaining("Run benchmark")])
  expect(window.localStorage.getItem(PREF_KEY)).toBe("p2")

  fireEvent.click(select)
  fireEvent.click(
    within(screen.getByRole("listbox", { name: "Project filter" })).getByRole("option", {
      name: "All projects",
    }),
  )
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/science/tasks", search: {}, replace: true })
  expect(window.localStorage.getItem(PREF_KEY)).toBe("")
})

test("opens on the remembered project", async () => {
  window.localStorage.setItem(PREF_KEY, "p1")
  renderTasks(undefined)
  const select = (await screen.findByTestId("tasks-project-select")) as HTMLButtonElement
  await waitFor(() => expect(select.value).toBe("p1"))
  expect(cardTitles()).toEqual([expect.stringContaining("Build parser")])
})

test("arriving with an agent to focus opens it as the active tab of the session panel", async () => {
  renderTasks("p2", { sessionId: "agent-9", agentId: "claude-code", agentLabel: "Claude Code" })
  const terminal = await screen.findByTestId("terminal")
  expect(terminal.getAttribute("data-session-id")).toBe("agent-9")
  expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("false")
  const tab = screen.getByTestId("central-tab")
  expect(tab.getAttribute("data-active")).toBe("true")
  expect(tab.textContent).toContain("Claude Code")
})

test("the right panel collapses to a thin bar card beside the board, and its button opens it again", async () => {
  renderTasks("p1")
  const aside = screen.getByTestId("science-sessions")
  expect(aside.getAttribute("data-collapsed")).toBe("false")
  expect(screen.queryByTestId("tasks-collapsed-bar")).toBeNull()
  fireEvent.click(await within(aside).findByTestId("right-sidebar-collapse"))
  expect(aside.getAttribute("data-collapsed")).toBe("true")
  const bar = screen.getByTestId("tasks-collapsed-bar")
  // The expand button is in the bar, not in the board's toolbar.
  expect(screen.getByTestId("tasks-board").contains(bar)).toBe(false)
  fireEvent.click(within(bar).getByTestId("science-sessions-expand"))
  expect(aside.getAttribute("data-collapsed")).toBe("false")
  expect(screen.queryByTestId("tasks-collapsed-bar")).toBeNull()
})
