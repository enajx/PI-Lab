import { QueryClient } from "@tanstack/react-query"
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

  test("header orders Auto research, Plan research, agents, and Caffeine and prevents duplicate launches", async () => {
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
    expect(
      plan.nextElementSibling?.querySelector("[data-testid=agent-status-control]"),
    ).toBeTruthy()
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

  test("keeps project type editing out of the project header", async () => {
    renderWorkspace()
    await screen.findByRole("heading", { name: "Photon Drift" })
    expect(screen.queryByTestId("project-view-type")).toBeNull()
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
    const tabSelect = await screen.findByLabelText("Auto-research")
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
