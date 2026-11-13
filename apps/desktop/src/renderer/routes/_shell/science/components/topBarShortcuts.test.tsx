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

  test("with All projects, the menu lists only Research diary, and the diary and skill buttons ask to pick a project", async () => {
    window.localStorage.setItem(
      "pi-lab.tasks.headerShortcuts",
      JSON.stringify(["skill:review-notes"]),
    )
    mount(<ScienceTasks initialProjectId={undefined} focusSession={null} />, tasksHandlers([]))
    const banner = screen.getByRole("banner")
    const button = await within(banner).findByTestId("tasks-shortcut-skill-review-notes")
    expect(button.hasAttribute("disabled")).toBe(true)
    expect(button.getAttribute("title")).toBe("Pick a project")
    const diary = within(banner).getByTestId("tasks-research-diary")
    expect(diary.hasAttribute("disabled")).toBe(true)
    expect(diary.getAttribute("title")).toBe("Pick a project")

    fireEvent.click(within(banner).getByTestId("tasks-shortcuts-add"))
    const menu = await screen.findByRole("menu", { name: "Header shortcuts" })
    expect(
      within(menu)
        .queryAllByRole("menuitemcheckbox")
        .map((item) => item.textContent),
    ).toEqual(["Research diary"])
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

  test("the top bar has the + button, then the project picker, then icon-only buttons named in their hover tip", async () => {
    mount(<ScienceAnalysis initialProjectId={undefined} focusSession={null} />, {
      ...sessionHandlers(),
      "projects.list": () => [project("p1", "alpha")],
      "projects.capabilities": () => ({ git: true }),
      "workflows.status": () => ({ planResearch: null, fetchExperiments: null }),
      "science.analysis.listFiles": () => ({ groups: [], total: 0, truncated: false }),
    })
    const banner = screen.getByRole("banner")
    const analyze = await within(banner).findByTestId("analysis-analyze-experiments")
    const add = within(banner).getByTestId("analysis-shortcuts-add")
    const picker = within(banner).getByTestId("analysis-project-select")
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(add, picker)).toBe(true)
    expect(follows(picker, analyze)).toBe(true)
    const names: Record<string, string> = {
      "analysis-analyze-experiments": "Analyze experiments",
      "analysis-report": "Report",
      "analysis-fetch-experiments": "Fetch experiments",
      "analysis-research-diary": "Research diary",
    }
    // Fetch experiments names itself once the Git check is done.
    await waitFor(() =>
      expect(within(banner).getByTestId("analysis-fetch-experiments").getAttribute("title")).toBe(
        "Fetch experiments",
      ),
    )
    for (const [testId, name] of Object.entries(names)) {
      const button = within(banner).getByTestId(testId)
      expect(button.textContent).toBe("")
      expect(button.querySelector("svg")).toBeTruthy()
      expect(button.getAttribute("data-feature-label")).toBe(name)
      expect(button.getAttribute("title")).toBe(name)
    }
  })

  test("Report starts its agent in the Analysis session panel", async () => {
    const started: unknown[] = []
    mount(<ScienceAnalysis initialProjectId={undefined} focusSession={null} />, {
      ...analysisHandlers(),
      "sessions.startReport": (input) => {
        started.push(input)
        return {
          sessionId: "report-1",
          workspaceId: "ws-1",
          kind: "branch",
          agentId: "claude-code",
          warning: null,
        }
      },
    })
    const banner = screen.getByRole("banner")
    const button = await within(banner).findByTestId("analysis-report")
    expect(button.getAttribute("title")).toBe("Report")
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(started).toEqual([{ projectId: "p1" }]))
    const panel = screen.getByTestId("science-sessions")
    // The shared workspace recovery store still holds the previous test's "analyze-1" tab
    // for p1; the panel drops it once terminal.list shows it is gone, so wait for report-1.
    await waitFor(() =>
      expect(within(panel).getByTestId("terminal").getAttribute("data-session-id")).toBe(
        "report-1",
      ),
    )
    expect(
      within(panel)
        .getAllByTestId("central-tab-select")
        .some((tab) => tab.getAttribute("aria-label") === "Report"),
    ).toBe(true)
  })

  test("Report shows the error when the report skill is missing", async () => {
    mount(<ScienceAnalysis initialProjectId={undefined} focusSession={null} />, {
      ...analysisHandlers(),
      "sessions.startReport": () => {
        throw new Error('The report skill "experiment-report" was not found.')
      },
    })
    const button = await within(screen.getByRole("banner")).findByTestId("analysis-report")
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false))
    fireEvent.click(button)
    expect((await screen.findByTestId("analysis-shortcut-error")).textContent).toContain(
      'The report skill "experiment-report" was not found.',
    )
  })

  test("a saved list with the old HTML report id shows Report in its place", async () => {
    window.localStorage.setItem(
      "pi-lab.analysis.headerShortcuts",
      JSON.stringify(["html-report", "analyze-experiments"]),
    )
    window.localStorage.setItem("pi-lab.analysis.headerShortcutsVersion", "4")
    mount(<ScienceAnalysis initialProjectId={undefined} focusSession={null} />, analysisHandlers())
    const banner = screen.getByRole("banner")
    await within(banner).findByTestId("analysis-report")
    const menu = await openAnalysisMenu()
    expect(builtinItems(menu)).toEqual([
      ["Analyze experiments", "true"],
      ["Report", "true"],
      ["Fetch experiments", "false"],
      ["Research diary", "false"],
    ])
  })

  test("the menu lists Analyze experiments, Report and Fetch experiments, all checked; Report can be removed and added back", async () => {
    mount(<ScienceAnalysis initialProjectId={undefined} focusSession={null} />, analysisHandlers())
    const banner = screen.getByRole("banner")
    await within(banner).findByTestId("analysis-analyze-experiments")
    expect(within(banner).getByTestId("analysis-report")).toBeTruthy()
    expect(within(banner).getByTestId("analysis-fetch-experiments")).toBeTruthy()

    const menu = await openAnalysisMenu()
    expect(builtinItems(menu)).toEqual([
      ["Analyze experiments", "true"],
      ["Report", "true"],
      ["Fetch experiments", "true"],
      ["Research diary", "true"],
    ])
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Report" }))
    await waitFor(() => expect(within(banner).queryByTestId("analysis-report")).toBeNull())
    expect(
      within(menu).getByRole("menuitemcheckbox", { name: "Report" }).getAttribute("aria-checked"),
    ).toBe("false")
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Report" }))
    await waitFor(() => expect(within(banner).getByTestId("analysis-report")).toBeTruthy())
  })

  test("a list saved before Report and Fetch experiments were listable gets them added; a removed one stays removed", async () => {
    window.localStorage.setItem(
      "pi-lab.analysis.headerShortcuts",
      JSON.stringify(["analyze-experiments", "skill:review-notes"]),
    )
    mount(<ScienceAnalysis initialProjectId={undefined} focusSession={null} />, analysisHandlers())
    const banner = screen.getByRole("banner")
    await within(banner).findByTestId("analysis-report")
    expect(within(banner).getByTestId("analysis-fetch-experiments")).toBeTruthy()
    let menu = await openAnalysisMenu()
    expect(builtinItems(menu)).toEqual([
      ["Analyze experiments", "true"],
      ["Report", "true"],
      ["Fetch experiments", "true"],
      ["Research diary", "true"],
    ])

    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Report" }))
    await waitFor(() => expect(within(banner).queryByTestId("analysis-report")).toBeNull())
    expect(
      JSON.parse(window.localStorage.getItem("pi-lab.analysis.headerShortcuts") ?? ""),
    ).toEqual(["analyze-experiments", "fetch-experiments", "research-diary", "skill:review-notes"])

    cleanup()
    mount(<ScienceAnalysis initialProjectId={undefined} focusSession={null} />, analysisHandlers())
    const again = screen.getByRole("banner")
    await within(again).findByTestId("analysis-analyze-experiments")
    expect(within(again).queryByTestId("analysis-report")).toBeNull()
    menu = await openAnalysisMenu()
    expect(builtinItems(menu)).toEqual([
      ["Analyze experiments", "true"],
      ["Report", "false"],
      ["Fetch experiments", "true"],
      ["Research diary", "true"],
    ])
  })
})
