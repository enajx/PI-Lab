import { QueryClient } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router"
import { observable } from "@trpc/server/observable"
import { beforeEach, describe, expect, test } from "vitest"
import type { LiveAgentStatus } from "../../../shared/agentStatus"
import { AppProviders } from "../../providers/AppProviders"
import { createFakeTrpcClient } from "../../test/fakeTrpcClient"
import { act, fireEvent, render, screen, waitFor } from "../../test/render"
import { AgentShortcuts, currentProjectId, nextAgent, orderWaitingAgents } from "./-agentShortcuts"
import { ProjectActivityProvider } from "./-ProjectActivity"

/** A live agent status row with the fields the shortcuts read. */
function agent(
  sessionId: string,
  projectId: string,
  state: LiveAgentStatus["state"],
  origin: LiveAgentStatus["origin"],
): LiveAgentStatus {
  return {
    sessionId,
    projectId,
    projectName: projectId,
    agentId: "claude",
    workspaceId: `ws-${projectId}`,
    origin,
    state,
  }
}

describe("orderWaitingAgents", () => {
  test("keeps waiting agents only, in sidebar project order, then start order", () => {
    const statuses = [
      agent("a1", "alpha", "waiting", "project"),
      agent("b1", "beta", "waiting", "latex"),
      agent("a2", "alpha", "working", "project"),
      agent("a3", "alpha", "waiting", "project"),
      agent("b2", "beta", "waiting", "project"),
    ]
    const ids = orderWaitingAgents(statuses, ["beta", "alpha"], null).map((row) => row.sessionId)
    expect(ids).toEqual(["b1", "b2", "a1", "a3"])
  })

  test("limits to one project when a scope is given", () => {
    const statuses = [
      agent("a1", "alpha", "waiting", "project"),
      agent("b1", "beta", "waiting", "project"),
    ]
    const ids = orderWaitingAgents(statuses, ["alpha", "beta"], "beta").map((row) => row.sessionId)
    expect(ids).toEqual(["b1"])
  })

  test("leaves out a project agent without a workspace, which no view can open", () => {
    const orphan = { ...agent("a1", "alpha", "waiting", "project"), workspaceId: null }
    expect(orderWaitingAgents([orphan], ["alpha"], null)).toEqual([])
  })
})

describe("nextAgent", () => {
  const ordered = [
    agent("s1", "p", "waiting", "project"),
    agent("s2", "p", "waiting", "project"),
    agent("s3", "p", "waiting", "project"),
  ]

  test("starts at the first agent, then cycles and wraps", () => {
    expect(nextAgent(ordered, null)?.sessionId).toBe("s1")
    expect(nextAgent(ordered, "s1")?.sessionId).toBe("s2")
    expect(nextAgent(ordered, "s3")?.sessionId).toBe("s1")
  })

  test("starts over when the last agent is no longer waiting, and is null when none wait", () => {
    expect(nextAgent(ordered, "gone")?.sessionId).toBe("s1")
    expect(nextAgent([], "s1")).toBeNull()
  })
})

describe("currentProjectId", () => {
  test("reads the project view path and the LaTeX Editor search", () => {
    expect(currentProjectId("/projects/p%201", {})).toBe("p 1")
    expect(currentProjectId("/science/latex", { projectId: "p2" })).toBe("p2")
    expect(currentProjectId("/science/latex", {})).toBeNull()
    expect(currentProjectId("/", {})).toBeNull()
  })
})

/** Shows the current location so a test can assert where a shortcut went. */
function Location() {
  const location = useRouterState({ select: (state) => state.location })
  return (
    <div data-testid="location" data-path={location.pathname}>
      {JSON.stringify(location.search)}
    </div>
  )
}

/**
 * Mount the shell pieces the shortcuts use (status provider, projects list, a
 * memory router with Dashboard, project and LaTeX Editor stand-ins) over a fake
 * tRPC server. The statuses and projects are mocked, not a live main process.
 */
function renderShell(initialPath: string, statuses: LiveAgentStatus[]) {
  const client = createFakeTrpcClient({
    "sessions.onStatus": () =>
      observable<LiveAgentStatus[]>((observer) => {
        observer.next(statuses)
        return () => {}
      }),
    "projects.list": () =>
      listedProjectIds.map((id) => ({
        id,
        name: id === "alpha" ? "Alpha" : "Beta",
        repoPath: `/${id}`,
        archivedAt: null,
      })),
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: function ShellStandIn() {
      const location = useRouterState({ select: (state) => state.location })
      return (
        <ProjectActivityProvider>
          <AgentShortcuts pathname={location.pathname} search={location.search} />
          <Location />
          <Outlet />
        </ProjectActivityProvider>
      )
    },
  })
  const routes = ["/", "/projects/$projectId", "/science/latex"].map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
  )
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      {/* biome-ignore lint/suspicious/noExplicitAny: test router type plumbing. */}
      <RouterProvider router={router as any} />
    </AppProviders>,
  )
}

/** Wait until the fake status stream and projects list have reached the shell. */
async function settle(): Promise<void> {
  await screen.findByTestId("location")
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

function location(): { path: string | null; search: Record<string, string> } {
  const node = screen.getByTestId("location")
  return { path: node.getAttribute("data-path"), search: JSON.parse(node.textContent ?? "{}") }
}

/** The saved project order that the fake `projects.list` returns. */
let listedProjectIds: string[] = []

beforeEach(() => {
  window.localStorage.clear()
  listedProjectIds = ["alpha", "beta"]
})

describe("AgentShortcuts", () => {
  const statuses = [
    agent("a1", "alpha", "waiting", "project"),
    agent("b1", "beta", "waiting", "latex"),
    agent("a2", "alpha", "working", "project"),
  ]

  test("⌥Tab opens each waiting agent in turn across projects, by origin", async () => {
    listedProjectIds = ["beta", "alpha"]
    // An old sidebar-only order left in local storage is ignored.
    window.localStorage.setItem("pi-lab.sidebar.projectOrder", JSON.stringify(["alpha", "beta"]))
    renderShell("/", statuses)
    await settle()

    const first = fireEvent.keyDown(document.body, { key: "Tab", altKey: true })
    expect(first).toBe(false)
    await waitFor(() => expect(location().path).toBe("/science/latex"))
    expect(location().search).toMatchObject({
      projectId: "beta",
      sessionId: "b1",
      agentId: "claude",
    })

    fireEvent.keyDown(document.body, { key: "Tab", altKey: true })
    await waitFor(() => expect(location().path).toBe("/projects/alpha"))
    expect(location().search).toMatchObject({
      notificationKind: "agent",
      notificationSessionId: "a1",
      notificationWorkspaceId: "ws-alpha",
      notificationAgentId: "claude",
    })

    fireEvent.keyDown(document.body, { key: "Tab", altKey: true })
    await waitFor(() => expect(location().path).toBe("/science/latex"))
  })

  test("⌥Tab inside a terminal is taken before the terminal sees it", async () => {
    renderShell("/", statuses)
    await settle()
    const terminal = document.createElement("div")
    terminal.className = "xterm"
    const input = document.createElement("textarea")
    terminal.appendChild(input)
    document.body.appendChild(terminal)
    let terminalSaw = false
    input.addEventListener("keydown", () => {
      terminalSaw = true
    })
    input.focus()
    fireEvent.keyDown(input, { key: "Tab", altKey: true })
    terminal.remove()
    expect(terminalSaw).toBe(false)
    await waitFor(() => expect(location().path).toBe("/projects/alpha"))
  })

  test("⌥⇧Tab stays in the current project", async () => {
    renderShell("/projects/beta", [...statuses, agent("b2", "beta", "waiting", "project")])
    await settle()
    fireEvent.keyDown(document.body, { key: "Tab", altKey: true, shiftKey: true })
    await waitFor(() => expect(location().path).toBe("/science/latex"))
    expect(location().search).toMatchObject({ sessionId: "b1" })
  })

  test("shows a notice and stays put when no agent is waiting", async () => {
    renderShell("/", [agent("a2", "alpha", "working", "project")])
    await settle()
    fireEvent.keyDown(document.body, { key: "Tab", altKey: true })
    expect((await screen.findByRole("status")).textContent).toBe("No agent is waiting for input")
    expect(location().path).toBe("/")
  })

  test("⌥⇧Tab without a current project asks to open one first", async () => {
    renderShell("/", statuses)
    await settle()
    fireEvent.keyDown(document.body, { key: "Tab", altKey: true, shiftKey: true })
    expect((await screen.findByRole("status")).textContent).toBe("Open a project first")
    expect(location().path).toBe("/")
  })

  test("leaves the key alone while a dialog is open", async () => {
    renderShell("/", statuses)
    await settle()
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    document.body.appendChild(dialog)
    const notPrevented = fireEvent.keyDown(document.body, { key: "Tab", altKey: true })
    dialog.remove()
    expect(notPrevented).toBe(true)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(location().path).toBe("/")
  })

  test("follows a rebind from Settings", async () => {
    window.localStorage.setItem(
      "pi-lab.shortcuts",
      JSON.stringify({ "next-waiting-agent": "Mod+j" }),
    )
    renderShell("/", statuses)
    await settle()
    expect(fireEvent.keyDown(document.body, { key: "Tab", altKey: true })).toBe(true)
    fireEvent.keyDown(document.body, { key: "j", metaKey: true })
    await waitFor(() => expect(location().path).toBe("/projects/alpha"))
  })
})
