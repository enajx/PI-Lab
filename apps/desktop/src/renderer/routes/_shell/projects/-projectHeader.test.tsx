import { QueryClient } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { afterEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../test/fakeTrpcClient"
// StrictMode-wrapped render (see test/render.tsx): reproduces the dev build's
// effect double-invoke so project-view mount effects are exercised as they run.
import { fireEvent, render, screen, waitFor, within } from "../../../test/render"
import { ProjectWorkspace } from "./-ProjectWorkspace"
import { setPendingLaunch } from "./-pendingLaunch"

// A card-launched session attaches to the central panel, which mounts a Terminal
// per pane; stub it so a pane needs no live PTY (mirrors CentralPanel's own test).
vi.mock("../../../Terminal", () => ({
  Terminal: ({ inputKind, sessionId }: { inputKind: "agent" | "terminal"; sessionId?: string }) => (
    <div data-testid="terminal" data-input-kind={inputKind} data-session-id={sessionId} />
  ),
}))

function renderWorkspace(handlers: FakeHandlers = {}) {
  const client = createFakeTrpcClient({
    "caffeine.status": () => ({ mode: "off", scope: "system-only", held: false }),
    "projects.get": () => ({
      id: "p1",
      name: "Photon Drift",
      repoPath: "/tmp/photon-drift",
    }),
    "projects.touch": () => ({}),
    "projects.capabilities": () => ({ git: true }),
    "settings.get": () => ({}),
    "workflows.status": () => ({ planResearch: null, fetchExperiments: null }),
    "workspaces.ensureMain": () => new Promise(() => {}),
    ...handlers,
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ProjectWorkspace projectId="p1" activation={{}} />
    </AppProviders>,
  )
}

describe("Project header", () => {
  afterEach(() => window.localStorage.clear())

  test("header orders Tasks, Auto research, Plan research, Project status, agents, and Caffeine and prevents duplicate launches", async () => {
    const calls: unknown[] = []
    let rejectLaunch!: (error: Error) => void
    renderWorkspace({
      "workspaces.ensureMain": () => ({ id: "w1" }),
      "sessions.startAutoResearch": (input) => {
        calls.push(input)
        return new Promise((_resolve, reject) => {
          rejectLaunch = reject
        })
      },
    })
    const button = await screen.findByTestId("project-view-auto-research")
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false))
    const plan = screen.getByTestId("project-view-plan-research")
    expect(button.nextElementSibling).toBe(plan)
    // Plan research → Project status → Agents status.
    const status = screen.getByTestId("project-view-status")
    expect(plan.nextElementSibling).toBe(status)
    // In the header the Project status button shows only its icon.
    expect(status.textContent).toBe("")
    expect(status.getAttribute("title")).toBe("Project status")
    expect(status.getAttribute("aria-label")).toContain("Project status")
    expect(status.querySelector("svg")).toBeTruthy()
    expect(
      status.nextElementSibling?.querySelector("[data-testid=agent-status-control]"),
    ).toBeTruthy()
    // The "+" shortcut menu, then Tasks, open the row of header actions.
    const shortcuts = screen.getByTestId("project-view-shortcuts")
    expect(shortcuts.parentElement?.firstElementChild).toBe(shortcuts)
    expect(shortcuts.nextElementSibling).toBe(screen.getByTestId("project-view-tasks"))
    expect(screen.getByTestId("project-view-tasks").nextElementSibling).toBe(button)
    const caffeine = screen.getByTestId("caffeine-control")
    expect(
      button.parentElement?.lastElementChild === caffeine ||
        button.parentElement?.lastElementChild?.contains(caffeine),
    ).toBe(true)
    expect(screen.queryByTestId("project-view-fetch-experiments")).toBeNull()
    fireEvent.click(button)
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true))
    fireEvent.click(button)
    expect(calls).toEqual([{ projectId: "p1" }])
    rejectLaunch(new Error("Launch unavailable"))
    expect((await screen.findByTestId("project-launch-error")).textContent).toContain(
      "Launch unavailable",
    )
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false))
  })

  test("the Tasks button opens Tasks with this project chosen", async () => {
    const client = createFakeTrpcClient({
      "caffeine.status": () => ({ mode: "off", scope: "system-only", held: false }),
      "projects.get": () => ({ id: "p1", name: "Photon Drift", repoPath: "/tmp/photon-drift" }),
      "projects.touch": () => ({}),
      "projects.capabilities": () => ({ git: true }),
      "settings.get": () => ({}),
      "workflows.status": () => ({ planResearch: null, fetchExperiments: null }),
      "workspaces.ensureMain": () => new Promise(() => {}),
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const rootRoute = createRootRoute({ component: Outlet })
    const projectRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <ProjectWorkspace projectId="p1" activation={{}} />,
    })
    const tasksRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/science/tasks",
      validateSearch: (search: Record<string, unknown>) => ({
        projectId: typeof search.projectId === "string" ? search.projectId : "",
      }),
      component: () => (
        <div data-testid="on-tasks-route">
          {(tasksRoute.useSearch() as { projectId: string }).projectId}
        </div>
      ),
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([projectRoute, tasksRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    })
    render(
      <AppProviders client={client} queryClient={queryClient}>
        {/* biome-ignore lint/suspicious/noExplicitAny: test router type plumbing. */}
        <RouterProvider router={router as any} />
      </AppProviders>,
    )
    const tasks = await screen.findByTestId("project-view-tasks")
    expect(tasks.getAttribute("title")).toBe("Tasks")
    fireEvent.click(tasks)
    expect((await screen.findByTestId("on-tasks-route")).textContent).toBe("p1")
  })

  test("records opening a project for the recent-project menu", async () => {
    const touched: unknown[] = []
    renderWorkspace({
      "projects.touch": (input) => {
        touched.push(input)
        return {}
      },
    })
    await waitFor(() => expect(touched).toEqual([{ id: "p1" }]))
  })

  test("shows the project stage row right after the project name, before the shortcuts", async () => {
    renderWorkspace({
      "projects.get": () => ({
        id: "p1",
        name: "Photon Drift",
        repoPath: "/tmp/photon-drift",
        metadata: { stage: "paperWriting" },
      }),
    })
    const stage = await screen.findByTestId("project-view-stage")
    const title = screen.getByRole("heading", { level: 1, name: "Photon Drift" })
    expect(title.compareDocumentPosition(stage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const shortcuts = screen.getByTestId("project-view-shortcuts")
    expect(stage.compareDocumentPosition(shortcuts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      within(stage)
        .getByTestId("project-view-stage-step-paperWriting")
        .getAttribute("aria-current"),
    ).toBe("step")
  })

  test("keeps project type editing out of the project header", async () => {
    renderWorkspace()
    await screen.findByRole("heading", { name: "Photon Drift" })
    expect(screen.queryByTestId("project-view-type")).toBeNull()
  })

  test("the project title in the top bar is not bold and keeps its size", async () => {
    renderWorkspace()
    const title = await screen.findByRole("heading", { level: 1, name: "Photon Drift" })
    expect(title.className).not.toMatch(/font-(semibold|bold|medium)/)
    expect(title.className).toContain("text-sm")
  })

  test("translates the Git notice while preserving the project name", async () => {
    window.localStorage.setItem("pi-lab.interface.language", "nb")
    renderWorkspace({ "projects.capabilities": () => ({ git: false }) })

    const notice = await screen.findByTestId("non-git-project-notice")
    expect(notice.textContent).toContain("Dette prosjektet er ikke sporet med Git.")
    expect(await screen.findByRole("heading", { name: "Photon Drift" })).toBeTruthy()
  })
  test("renders the shared Caffeine control while the workspace opens", async () => {
    renderWorkspace()

    const control = await screen.findByTestId("caffeine-control")
    expect(control.closest("header")).toBeTruthy()
    expect(await screen.findByRole("heading", { name: "Photon Drift" })).toBeTruthy()
  })

  test("explains disabled Git features and initializes Git explicitly", async () => {
    let git = false
    const initializeCalls: unknown[] = []
    renderWorkspace({
      "projects.capabilities": () => ({ git }),
      "projects.initializeGit": (input) => {
        initializeCalls.push(input)
        git = true
        return {
          id: "p1",
          name: "Photon Drift",
          repoPath: "/tmp/photon-drift",
          defaultBranch: "main",
        }
      },
    })

    const notice = await screen.findByTestId("non-git-project-notice")
    expect(notice.textContent).toContain("This project is not git tracked")
    expect(notice.textContent).toContain("Initialize Git for worktrees and concurrent agents")
    expect(screen.getByTestId("project-view-plan-research").hasAttribute("disabled")).toBe(false)
    expect(screen.getByTestId("project-view-auto-research").hasAttribute("disabled")).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: "Initialize Git" }))

    await waitFor(() => expect(initializeCalls).toEqual([{ id: "p1" }]))
    await waitFor(() => expect(screen.queryByTestId("non-git-project-notice")).toBeNull())
    expect(screen.getByTestId("project-view-plan-research").hasAttribute("disabled")).toBe(false)
  })

  test("allows the concise non-Git notice to be dismissed", async () => {
    renderWorkspace({ "projects.capabilities": () => ({ git: false }) })
    await screen.findByTestId("non-git-project-notice")
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Git notice" }))
    expect(screen.queryByTestId("non-git-project-notice")).toBeNull()
  })

  test("keeps Git features disabled and surfaces a capability-check failure", async () => {
    renderWorkspace({
      "projects.capabilities": async () => {
        throw new Error("filesystem unavailable")
      },
    })

    const alert = await screen.findByTestId("project-git-capability-error")
    expect(alert.textContent).toContain("filesystem unavailable")
    expect(screen.getByTestId("project-view-plan-research").hasAttribute("disabled")).toBe(false)
    expect(screen.getByTestId("project-view-auto-research").hasAttribute("disabled")).toBe(true)
    expect(screen.queryByTestId("non-git-project-notice")).toBeNull()
  })

  test("a done Plan research control opens the result popup with a last-checked line", async () => {
    renderWorkspace({
      "workflows.status": () => ({
        planResearch: {
          running: false,
          result: "Photon Drift is on track.",
          inputHash: "h",
          lastCheckedAt: Date.now() - 120_000,
          errorMessage: null,
        },
        fetchExperiments: null,
      }),
      "workflows.run": () => ({
        cached: true,
        running: false,
        result: "Photon Drift is on track.",
        inputHash: "h",
        lastCheckedAt: Date.now(),
        errorMessage: null,
      }),
    })

    const button = await screen.findByTestId("project-view-plan-research")
    await waitFor(() => expect(button.getAttribute("data-state")).toBe("done"))

    fireEvent.click(button)

    const dialog = await screen.findByTestId("workflow-result-dialog")
    expect(within(dialog).getByTestId("workflow-result-text").textContent).toContain(
      "Photon Drift is on track.",
    )
    expect(within(dialog).getByTestId("workflow-result-last-checked").textContent).toContain(
      "Last checked:",
    )
    expect(dialog.textContent).toContain("Research plan")
  })

  test("an errored Plan research control surfaces the failure in the popup (no silent failure)", async () => {
    renderWorkspace({
      "workflows.status": () => ({
        planResearch: {
          running: false,
          result: "",
          inputHash: "h",
          lastCheckedAt: Date.now(),
          errorMessage: "model unavailable",
        },
        fetchExperiments: null,
      }),
      "workflows.run": () => ({
        cached: false,
        running: false,
        result: "",
        inputHash: "h",
        lastCheckedAt: Date.now(),
        errorMessage: "model unavailable",
      }),
    })

    const button = await screen.findByTestId("project-view-plan-research")
    await waitFor(() => expect(button.getAttribute("data-state")).toBe("error"))

    fireEvent.click(button)

    const dialog = await screen.findByTestId("workflow-result-dialog")
    expect(within(dialog).getByTestId("workflow-result-error").textContent).toContain(
      "model unavailable",
    )
    expect(within(dialog).queryByTestId("workflow-result-text")).toBeNull()
  })
})

/** Open the header's "+" shortcut menu and return it. */
async function openShortcutMenu(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId("project-view-shortcuts-add"))
  return screen.findByRole("menu", { name: "Header shortcuts" })
}

/** The data-testids of the header shortcut buttons, in header order. */
function headerShortcutIds(): string[] {
  const shortcuts = screen.getByTestId("project-view-shortcuts")
  const ids: string[] = []
  let next = shortcuts.nextElementSibling
  while (next?.getAttribute("data-testid")?.startsWith("project-view-")) {
    ids.push(next.getAttribute("data-testid") ?? "")
    next = next.nextElementSibling
  }
  return ids
}

describe("Project header shortcuts menu", () => {
  afterEach(() => window.localStorage.clear())

  const skillsCatalog = () => ({
    skills: [
      {
        name: "Review notes",
        description: "Review the lab notes",
        slug: "review-notes",
        path: "/tmp/photon-drift/.claude/skills/review-notes/SKILL.md",
        source: "Project Claude",
        harness: "claude",
        scope: "project",
      },
    ],
    roots: [],
  })

  test("lists the current shortcuts as added, and removing one removes its button for every project", async () => {
    renderWorkspace({ "science.skills.list": skillsCatalog, "automations.list": () => [] })
    await screen.findByTestId("project-view-tasks")
    expect(headerShortcutIds()).toEqual([
      "project-view-tasks",
      "project-view-auto-research",
      "project-view-plan-research",
      "project-view-status",
    ])
    const menu = await openShortcutMenu()
    const items = within(menu).getAllByRole("menuitemcheckbox").slice(0, 4)
    expect(items.map((item) => item.textContent)).toEqual([
      "Tasks",
      "Auto research",
      "Plan research",
      "Project status",
    ])
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
      "true",
      "true",
    ])
    // Skills and routines are folded into their own sections, not listed at the top level.
    expect(within(menu).queryByText("Review notes")).toBeNull()

    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Plan research" }))
    await waitFor(() => expect(screen.queryByTestId("project-view-plan-research")).toBeNull())
    expect(
      within(menu)
        .getByRole("menuitemcheckbox", { name: "Plan research" })
        .getAttribute("aria-checked"),
    ).toBe("false")
    expect(
      JSON.parse(window.localStorage.getItem("pi-lab.projectView.headerShortcuts") ?? ""),
    ).toEqual(["tasks", "auto-research", "project-status"])
  })

  test("adding a skill puts a button in the header that starts an agent with that skill", async () => {
    const calls: unknown[] = []
    renderWorkspace({
      "workspaces.ensureMain": () => ({ id: "w1" }),
      "agents.list": () => [],
      "agents.projectChoice": () => ({ agentId: null }),
      "science.skills.list": skillsCatalog,
      "automations.list": () => [],
      "sessions.startSkill": (input) => {
        calls.push(input)
        return {
          sessionId: "skill-1",
          workspaceId: "w1",
          kind: "branch",
          agentId: "codex",
          label: "Review notes",
        }
      },
    })
    const menu = await openShortcutMenu()
    const skills = within(menu).getByRole("button", { name: "Skills" })
    expect(skills.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(skills)
    fireEvent.click(await within(menu).findByRole("menuitemcheckbox", { name: "Review notes" }))

    const button = await screen.findByTestId("project-view-shortcut-skill-review-notes")
    expect(button.textContent).toContain("Review notes")
    expect(headerShortcutIds().at(-1)).toBe("project-view-shortcut-skill-review-notes")
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(calls).toEqual([{ projectId: "p1", skillSlug: "review-notes" }]))
    const tab = await waitFor(() => {
      const found = screen
        .getAllByTestId("central-tab")
        .find((entry) => entry.textContent?.includes("Review notes"))
      if (!found) throw new Error("No Review notes tab yet")
      return found
    })
    expect(tab?.getAttribute("data-tab-kind")).toBe("agent")
    expect((await screen.findByTestId("terminal")).getAttribute("data-session-id")).toBe("skill-1")
  })

  test("a skill shortcut the project does not have is disabled with the reason", async () => {
    window.localStorage.setItem(
      "pi-lab.projectView.headerShortcuts",
      JSON.stringify(["tasks", "skill:other-skill"]),
    )
    renderWorkspace({ "science.skills.list": skillsCatalog, "automations.list": () => [] })
    const button = await screen.findByTestId("project-view-shortcut-skill-other-skill")
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true))
    expect(button.getAttribute("title")).toContain("other-skill")
  })

  test("the Routines section says when there are no routines yet", async () => {
    renderWorkspace({ "science.skills.list": skillsCatalog, "automations.list": () => [] })
    const menu = await openShortcutMenu()
    fireEvent.click(within(menu).getByRole("button", { name: "Routines" }))
    expect((await within(menu).findByText("No routines yet")).textContent).toBe("No routines yet")
  })

  test("adding a routine puts a button that runs it now and opens it on the Routines page", async () => {
    window.localStorage.setItem("pi-lab.projectView.headerShortcuts", JSON.stringify(["tasks"]))
    const runs: unknown[] = []
    const client = createFakeTrpcClient({
      "caffeine.status": () => ({ mode: "off", scope: "system-only", held: false }),
      "projects.get": () => ({ id: "p1", name: "Photon Drift", repoPath: "/tmp/photon-drift" }),
      "projects.touch": () => ({}),
      "projects.capabilities": () => ({ git: true }),
      "settings.get": () => ({}),
      "workflows.status": () => ({ planResearch: null, fetchExperiments: null }),
      "workspaces.ensureMain": () => new Promise(() => {}),
      "science.skills.list": skillsCatalog,
      "automations.list": () => [
        {
          id: "a1",
          name: "Nightly sweep check",
          agentId: "codex",
          executionMode: "interactive",
          projectId: "p1",
          recurrenceRule: "FREQ=DAILY",
          scheduleSummary: "Daily",
          timezone: "UTC",
          enabled: true,
          nextRunAt: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      "automations.runNow": (input) => {
        runs.push(input)
        return { runId: "r1" }
      },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const rootRoute = createRootRoute({ component: Outlet })
    const projectRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <ProjectWorkspace projectId="p1" activation={{}} />,
    })
    const automationsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/automations",
      validateSearch: (search: Record<string, unknown>) => search,
      component: () => (
        <div data-testid="on-automations-route">{JSON.stringify(automationsRoute.useSearch())}</div>
      ),
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([projectRoute, automationsRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    })
    render(
      <AppProviders client={client} queryClient={queryClient}>
        {/* biome-ignore lint/suspicious/noExplicitAny: test router type plumbing. */}
        <RouterProvider router={router as any} />
      </AppProviders>,
    )
    const menu = await openShortcutMenu()
    fireEvent.click(within(menu).getByRole("button", { name: "Routines" }))
    fireEvent.click(
      await within(menu).findByRole("menuitemcheckbox", { name: "Nightly sweep check" }),
    )
    const button = await screen.findByTestId("project-view-shortcut-routine-a1")
    expect(button.textContent).toContain("Nightly sweep check")
    fireEvent.click(button)
    await waitFor(() => expect(runs).toEqual([{ id: "a1" }]))
    const search = JSON.parse((await screen.findByTestId("on-automations-route")).textContent ?? "")
    expect(search).toMatchObject({ notificationWorkflowId: "a1", notificationRunId: "r1" })
  })
})

/**
 * Regression (bug: a card-launched agent left the project workspace wedged on
 * "Opening project…"). A project card now records the launch intent and navigates
 * immediately; the project view picks it up on mount, opens the project via
 * `ensureMain` **independently** of the launch, runs the launch itself, and
 * attaches the returned session so it is selectable — or surfaces a failed launch,
 * never a silent failure or a permanent "Opening project…".
 */
describe("Card-triggered launch on the project view", () => {
  // Distinct projectIds per test: the central panel persists restored state per
  // project in a module-level store, so reusing one id would leak sessions between
  // cases. A resolving `ensureMain` opens the project independently of the launch.
  function renderLaunch(projectId: string, handlers: FakeHandlers) {
    const client = createFakeTrpcClient({
      "caffeine.status": () => ({ mode: "off", scope: "system-only", held: false }),
      "projects.get": () => ({
        id: projectId,
        name: "Photon Drift",
        repoPath: "/tmp/photon-drift",
      }),
      "projects.capabilities": () => ({ git: true }),
      "settings.get": () => ({}),
      "workflows.status": () => ({ planResearch: null, fetchExperiments: null }),
      "workspaces.ensureMain": () => ({ id: "w1" }),
      "agents.list": () => [],
      "agents.projectChoice": () => ({ agentId: null }),
      ...handlers,
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <AppProviders client={client} queryClient={queryClient}>
        <ProjectWorkspace projectId={projectId} activation={{}} />
      </AppProviders>,
    )
  }

  test("opens the project and attaches the auto-research session it launches", async () => {
    setPendingLaunch("launch-auto", { kind: "auto-research" })
    const calls: unknown[] = []
    renderLaunch("launch-auto", {
      "sessions.startAutoResearch": (input) => {
        calls.push(input)
        return { sessionId: "auto-1", workspaceId: "wt-1", kind: "worktree" as const }
      },
    })

    // The project opens (central panel mounts) rather than sticking on "Opening project…".
    await screen.findByTestId("central-panel")
    expect(screen.queryByText("Opening project…")).toBeNull()

    // The view — not the card — ran the launch, and its session attached as the
    // active, selectable agent tab (a pane the user can click into).
    await waitFor(() => expect(calls).toEqual([{ projectId: "launch-auto" }]))
    const tabSelect = await screen.findByRole("button", { name: "Auto-research" })
    const tab = tabSelect.closest("[data-testid='central-tab']")
    expect(tab?.getAttribute("data-tab-kind")).toBe("agent")
    expect(tab?.getAttribute("data-active")).toBe("true")
    expect((await screen.findByTestId("terminal")).getAttribute("data-session-id")).toBe("auto-1")
  })

  test("surfaces a failed card-triggered launch without wedging the view", async () => {
    setPendingLaunch("launch-auto-fail", { kind: "auto-research" })
    renderLaunch("launch-auto-fail", {
      "sessions.startAutoResearch": () => {
        throw new Error("cluster unreachable")
      },
    })

    // The project still opens, and the failure surfaces (no silent failure).
    await screen.findByTestId("central-panel")
    const banner = await screen.findByTestId("project-launch-error")
    expect(banner.textContent).toContain("cluster unreachable")
    expect(screen.queryByText("Opening project…")).toBeNull()
  })
})
