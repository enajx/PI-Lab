import type { Project } from "@pi-lab/local-db"
import { QueryClient } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../test/fakeTrpcClient"
import type { TaskSource } from "./ScienceTasks/TasksWorkspace"

/**
 * The "+" top bar shortcut menu in Tasks and Analysis. The tRPC server and the
 * router are fakes (mocked), and xterm is a stub that shows its session id; the
 * e2e test covers the real app.
 */
const mocks = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }))
vi.mock("../../../../Terminal", () => ({
  Terminal: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid="terminal" data-session-id={sessionId} />
  ),
}))

const { ScienceTasks } = await import("./ScienceTasks")
const { ScienceAnalysis } = await import("./ScienceAnalysis")

const skillsCatalog = () => ({
  skills: [
    {
      name: "Review notes",
      description: "Review the lab notes",
      slug: "review-notes",
      path: "/repos/alpha/.claude/skills/review-notes/SKILL.md",
      source: "Project Claude",
      harness: "claude",
      scope: "project",
    },
  ],
  roots: [],
})

/** Handlers the session panel needs to open a project's sessions. */
function sessionHandlers(): FakeHandlers {
  return {
    "workspaces.ensureMain": () => ({ id: "ws-1" }),
    "settings.get": () => ({ agents: { defaultAgentId: "claude-code" } }),
    "settings.updateEditor": () => ({}),
    "agents.list": () => [
      { id: "claude-code", label: "Claude Code", available: true, executable: "/usr/bin/claude" },
    ],
    "agents.projectChoice": () => ({ agentId: null, storage: "app" }),
    "terminal.list": () => [],
    "terminal.kill": () => ({ ok: true }),
    "files.tree": () => [],
    "science.skills.list": skillsCatalog,
    "automations.list": () => [],
  }
}

function mount(element: React.ReactElement, handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={createFakeTrpcClient(handlers)} queryClient={queryClient}>
      {element}
    </AppProviders>,
  )
}

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

function project(id: string, name: string): Project {
  return {
    id,
    name,
    repoPath: `/repos/${name}`,
    defaultBranch: "main",
    color: null,
    thumbnail: null,
    gradient: null,
    digitalRain: false,
    metadata: null,
    taskRelPath: null,
    mainRelPath: null,
    typeId: "general",
    agentConfig: null,
    sortIndex: 0,
    sortOrder: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
  }
}

beforeEach(() => {
  window.localStorage.clear()
  mocks.navigate.mockReset()
})
afterEach(() => cleanup())

describe("Tasks top bar shortcuts", () => {
  const tasksHandlers = (started: unknown[]): FakeHandlers => ({
    ...sessionHandlers(),
    "science.tasks.list": () => ({ tasks: [], sources: [source("p1", "alpha")] }),
    "sessions.startSkill": (input) => {
      started.push(input)
      return {
        sessionId: "skill-1",
        workspaceId: "ws-1",
        kind: "branch",
        agentId: "claude-code",
        label: "Review notes",
        warning: null,
      }
    },
  })

  test("with All projects, the menu has no built-ins and skill buttons ask to pick a project", async () => {
    window.localStorage.setItem(
      "pi-lab.tasks.headerShortcuts",
      JSON.stringify(["skill:review-notes"]),
    )
    mount(<ScienceTasks initialProjectId={undefined} focusSession={null} />, tasksHandlers([]))
    const banner = screen.getByRole("banner")
    const button = await within(banner).findByTestId("tasks-shortcut-skill-review-notes")
    expect(button.hasAttribute("disabled")).toBe(true)
    expect(button.getAttribute("title")).toBe("Pick a project")

    fireEvent.click(within(banner).getByTestId("tasks-shortcuts-add"))
    const menu = await screen.findByRole("menu", { name: "Header shortcuts" })
    expect(within(menu).queryAllByRole("menuitemcheckbox")).toEqual([])
    fireEvent.click(within(menu).getByRole("button", { name: "Skills" }))
    expect(within(menu).getByText("Pick a project to list its skills")).toBeTruthy()
  })

  test("with a project chosen, a skill button opens its agent in the Tasks session panel", async () => {
    window.localStorage.setItem(
      "pi-lab.tasks.headerShortcuts",
      JSON.stringify(["skill:review-notes"]),
    )
    const started: unknown[] = []
    mount(<ScienceTasks initialProjectId="p1" focusSession={null} />, tasksHandlers(started))
    const button = await screen.findByTestId("tasks-shortcut-skill-review-notes")
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false))
    fireEvent.click(button)

    await waitFor(() =>
      expect(started).toEqual([{ projectId: "p1", skillSlug: "review-notes", origin: "tasks" }]),
    )
    const panel = screen.getByTestId("science-sessions")
    expect((await within(panel).findByTestId("terminal")).getAttribute("data-session-id")).toBe(
      "skill-1",
    )
    expect(panel.getAttribute("data-collapsed")).toBe("false")
    expect(mocks.navigate).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: "/projects/$projectId" }),
    )
  })
})

describe("Analysis top bar shortcuts", () => {
  test("Analyze experiments is in the top bar by default and opens its agent in the Analysis session panel", async () => {
    const started: unknown[] = []
    mount(<ScienceAnalysis initialProjectId={undefined} focusSession={null} />, {
      ...sessionHandlers(),
      "projects.list": () => [project("p1", "alpha")],
      "projects.capabilities": () => ({ git: true }),
      "workflows.status": () => ({ planResearch: null, fetchExperiments: null }),
      "science.analysis.listFiles": () => ({ groups: [], total: 0, truncated: false }),
      "sessions.startAnalyzeExperiments": (input) => {
        started.push(input)
        return {
          sessionId: "analyze-1",
          workspaceId: "ws-1",
          kind: "branch",
          agentId: "claude-code",
          warning: null,
        }
      },
    })
    const banner = screen.getByRole("banner")
    const button = await within(banner).findByTestId("analysis-analyze-experiments")
    expect(button.textContent).toContain("Analyze experiments")

    fireEvent.click(within(banner).getByTestId("analysis-shortcuts-add"))
    const menu = await screen.findByRole("menu", { name: "Header shortcuts" })
    const item = within(menu).getByRole("menuitemcheckbox", { name: "Analyze experiments" })
    expect(item.getAttribute("aria-checked")).toBe("true")
    fireEvent.keyDown(window, { key: "Escape" })

    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(started).toEqual([{ projectId: "p1" }]))
    const panel = screen.getByTestId("science-sessions")
    expect((await within(panel).findByTestId("terminal")).getAttribute("data-session-id")).toBe(
      "analyze-1",
    )
    expect(
      within(panel)
        .getAllByTestId("central-tab-select")
        .some((tab) => tab.getAttribute("aria-label") === "Analyze experiments"),
    ).toBe(true)
  })

  const analysisHandlers = (): FakeHandlers => ({
    ...sessionHandlers(),
    "projects.list": () => [project("p1", "alpha")],
    "projects.capabilities": () => ({ git: true }),
    "workflows.status": () => ({ planResearch: null, fetchExperiments: null }),
    "science.analysis.listFiles": () => ({ groups: [], total: 0, truncated: false }),
  })

  /** The labels and checked states of the Analysis "+" menu's own buttons. */
  async function openAnalysisMenu() {
    fireEvent.click(within(screen.getByRole("banner")).getByTestId("analysis-shortcuts-add"))
    const menu = await screen.findByRole("menu", { name: "Header shortcuts" })
    return menu
  }
  const builtinItems = (menu: HTMLElement) =>
    within(menu)
      .getAllByRole("menuitemcheckbox")
      .map((item) => [item.textContent, item.getAttribute("aria-checked")])

  test("the menu lists Analyze experiments, HTML report and Fetch experiments, all checked; HTML report can be removed and added back", async () => {
    mount(<ScienceAnalysis initialProjectId={undefined} focusSession={null} />, analysisHandlers())
    const banner = screen.getByRole("banner")
    await within(banner).findByTestId("analysis-analyze-experiments")
    expect(within(banner).getByTestId("analysis-new-html-report")).toBeTruthy()
    expect(within(banner).getByTestId("analysis-fetch-experiments")).toBeTruthy()

    const menu = await openAnalysisMenu()
    expect(builtinItems(menu)).toEqual([
      ["Analyze experiments", "true"],
      ["HTML report", "true"],
      ["Fetch experiments", "true"],
      ["Research diary", "true"],
    ])
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "HTML report" }))
    await waitFor(() => expect(within(banner).queryByTestId("analysis-new-html-report")).toBeNull())
    expect(
      within(menu)
        .getByRole("menuitemcheckbox", { name: "HTML report" })
        .getAttribute("aria-checked"),
    ).toBe("false")
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "HTML report" }))
    await waitFor(() => expect(within(banner).getByTestId("analysis-new-html-report")).toBeTruthy())
  })

  test("a list saved before HTML report and Fetch experiments were listable gets them added; a removed one stays removed", async () => {
    window.localStorage.setItem(
      "pi-lab.analysis.headerShortcuts",
      JSON.stringify(["analyze-experiments", "skill:review-notes"]),
    )
    mount(<ScienceAnalysis initialProjectId={undefined} focusSession={null} />, analysisHandlers())
    const banner = screen.getByRole("banner")
    await within(banner).findByTestId("analysis-new-html-report")
    expect(within(banner).getByTestId("analysis-fetch-experiments")).toBeTruthy()
    let menu = await openAnalysisMenu()
    expect(builtinItems(menu)).toEqual([
      ["Analyze experiments", "true"],
      ["HTML report", "true"],
      ["Fetch experiments", "true"],
      ["Research diary", "true"],
    ])

    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "HTML report" }))
    await waitFor(() => expect(within(banner).queryByTestId("analysis-new-html-report")).toBeNull())
    expect(
      JSON.parse(window.localStorage.getItem("pi-lab.analysis.headerShortcuts") ?? ""),
    ).toEqual(["analyze-experiments", "fetch-experiments", "research-diary", "skill:review-notes"])

    cleanup()
    mount(<ScienceAnalysis initialProjectId={undefined} focusSession={null} />, analysisHandlers())
    const again = screen.getByRole("banner")
    await within(again).findByTestId("analysis-analyze-experiments")
    expect(within(again).queryByTestId("analysis-new-html-report")).toBeNull()
    menu = await openAnalysisMenu()
    expect(builtinItems(menu)).toEqual([
      ["Analyze experiments", "true"],
      ["HTML report", "false"],
      ["Fetch experiments", "true"],
      ["Research diary", "true"],
    ])
  })
})
