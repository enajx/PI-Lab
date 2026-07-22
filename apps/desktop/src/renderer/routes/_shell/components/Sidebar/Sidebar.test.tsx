import { QueryClient } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../test/fakeTrpcClient"
import { writeProjectWorkspaceState } from "../../projects/-workspaceState"
import { Sidebar } from "./Sidebar"

/**
 * Component test for the left sidebar (md/engineering/testing-and-build.md). Mounts the
 * real `Sidebar` under the app providers + a memory router (so its `<Link>`s
 * resolve) with a faked tRPC client. jsdom suffices — the sidebar is plain DOM
 * (no Radix). We cover the unified workspace nav (Workflows still reachable), the
 * persisted project ordering, and the Add-project dropdown (the template item is
 * now a direct folder pick, not an inline name form).
 */

function renderSidebar(handlers: FakeHandlers = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({ "projects.list": () => [], ...handlers })

  // A handful of stub routes so the sidebar's `<Link>` targets resolve.
  const rootRoute = createRootRoute({ component: Sidebar })
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      stub("/projects/$projectId"),
      stub("/automations"),
      stub("/settings"),
      stub("/science/library"),
      stub("/science/analysis"),
      stub("/science/cluster"),
      stub("/science/skills"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })

  const result = render(
    <AppProviders client={client} queryClient={queryClient}>
      {/* biome-ignore lint/suspicious/noExplicitAny: test router type plumbing. */}
      <RouterProvider router={router as any} />
    </AppProviders>,
  )
  return { ...result, router }
}

describe("Sidebar", () => {
  // Reset persisted layout prefs (nav/project order) so tests don't bleed order.
  beforeEach(() => {
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  test("the Add-project trigger opens a menu with three options", async () => {
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("add-project")).toBeTruthy())

    expect(screen.queryByTestId("add-project-menu")).toBeNull()

    fireEvent.click(screen.getByTestId("add-project"))

    expect(screen.getByTestId("add-project-menu")).toBeTruthy()
    expect(screen.getByTestId("add-project-folder")).toBeTruthy()
    expect(screen.getByTestId("add-project-clone")).toBeTruthy()
    expect(screen.getByTestId("add-project-template")).toBeTruthy()
  })

  test("the clone item reveals an inline git-URL form", async () => {
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("add-project")).toBeTruthy())

    fireEvent.click(screen.getByTestId("add-project"))
    fireEvent.click(screen.getByTestId("add-project-clone"))

    expect(screen.getByTestId("add-project-clone-form")).toBeTruthy()
    expect(screen.getByTestId("add-project-clone-url")).toBeTruthy()
    // The folder/template items give way to the form once a mode is chosen.
    expect(screen.queryByTestId("add-project-folder")).toBeNull()
  })

  test("the template item picks a target folder and creates — no inline name form", async () => {
    let templateInput: unknown
    renderSidebar({
      "system.pickDirectory": () => "/tmp/target",
      "projects.createFromTemplate": (input) => {
        templateInput = input
        return { id: "tmpl", name: "tmpl", repoPath: "/tmp/target" }
      },
    })
    await waitFor(() => expect(screen.getByTestId("add-project")).toBeTruthy())

    fireEvent.click(screen.getByTestId("add-project"))
    fireEvent.click(screen.getByTestId("add-project-template"))

    // No inline name form any more — it's a direct folder pick → createFromTemplate.
    expect(screen.queryByTestId("add-project-template-form")).toBeNull()
    await waitFor(() => expect(templateInput).toEqual({ targetDir: "/tmp/target" }))
  })

  test("Escape closes the menu", async () => {
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("add-project")).toBeTruthy())

    fireEvent.click(screen.getByTestId("add-project"))
    expect(screen.getByTestId("add-project-menu")).toBeTruthy()

    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByTestId("add-project-menu")).toBeNull()
  })

  test("Workflows is reachable inside the single workspace nav", async () => {
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("nav-automations")).toBeTruthy())

    const workflows = screen.getByTestId("nav-automations")
    expect(workflows.textContent).toContain("Workflows")
    // Workflows shares the one nav with the science rows (not a separate block).
    expect(screen.getByTestId("science-nav").contains(workflows)).toBe(true)
    expect(screen.getAllByTestId("science-nav-item").length).toBeGreaterThan(0)
  })

  test("hides Cluster/Analysis nav rows when their section preference is off, restores when on", async () => {
    const clusterTab = () =>
      screen
        .queryAllByTestId("science-nav-item")
        .find((item) => item.getAttribute("data-science-tab") === "cluster")
    const analysisTab = () =>
      screen
        .queryAllByTestId("science-nav-item")
        .find((item) => item.getAttribute("data-science-tab") === "analysis")

    // Shown by default.
    const shown = renderSidebar()
    await waitFor(() => expect(screen.getByTestId("science-nav")).toBeTruthy())
    expect(clusterTab()).toBeTruthy()
    expect(analysisTab()).toBeTruthy()
    shown.unmount()

    // Off ⇒ both rows gone.
    window.localStorage.setItem("pi-lab.sections.showCluster", "false")
    window.localStorage.setItem("pi-lab.sections.showAnalysis", "false")
    const hidden = renderSidebar()
    await waitFor(() => expect(screen.getByTestId("science-nav")).toBeTruthy())
    expect(clusterTab()).toBeUndefined()
    expect(analysisTab()).toBeUndefined()
    // The other science rows stay put.
    expect(
      screen
        .getAllByTestId("science-nav-item")
        .some((item) => item.getAttribute("data-science-tab") === "tasks"),
    ).toBe(true)
    hidden.unmount()

    // Back on ⇒ both rows return.
    window.localStorage.setItem("pi-lab.sections.showCluster", "true")
    window.localStorage.setItem("pi-lab.sections.showAnalysis", "true")
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("science-nav")).toBeTruthy())
    expect(clusterTab()).toBeTruthy()
    expect(analysisTab()).toBeTruthy()
  })

  test("Projects Dashboard navigation uses the home route", async () => {
    const { router } = renderSidebar({
      "projects.list": () => [{ id: "a", name: "Alpha", repoPath: "/a" }],
    })
    await waitFor(() => expect(screen.getByTestId("project-item")).toBeTruthy())

    const projectsDashboard = screen.getByTestId("nav-dashboard")
    expect(projectsDashboard.textContent).toContain("Projects Dashboard")
    expect(projectsDashboard.parentElement?.className).toContain("border-b")
    expect(screen.getByTestId("project-agent-status").getAttribute("data-status")).toBe("empty")
    fireEvent.click(screen.getByTestId("project-item"))
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/a"))

    fireEvent.click(screen.getByTestId("nav-project-dashboard"))
    await waitFor(() => expect(router.state.location.pathname).toBe("/"))
  })

  test("a project’s sidebar ring reflects its active agent state", async () => {
    renderSidebar({
      "projects.list": () => [{ id: "a", name: "Alpha", repoPath: "/a" }],
      "sessions.activity": () => [{ projectId: "a", state: "working" }],
    })
    await waitFor(() => expect(screen.getByTestId("project-agent-status")).toBeTruthy())

    expect(screen.getByTestId("project-agent-status").getAttribute("data-status")).toBe("working")
  })

  test("an expanded project row uses its thumbnail as the project badge", async () => {
    const { container } = renderSidebar({
      "projects.list": () => [
        {
          id: "a",
          name: "Alpha",
          repoPath: "/a",
          thumbnail: "data:image/png;base64,AA==",
        },
      ],
    })
    await waitFor(() => expect(screen.getByTestId("project-item")).toBeTruthy())

    const thumbnail = container.querySelector('[data-testid="project-sessions-toggle"] img')
    expect(thumbnail?.getAttribute("src")).toBe("data:image/png;base64,AA==")
  })

  test("the project badge toggles direct session links and a session opens in its project", async () => {
    writeProjectWorkspaceState("sessions-project", {
      buffers: [],
      activeRelPath: null,
      sessions: [
        {
          id: "pane-1",
          kind: "agent",
          sessionId: "session-1",
          label: "Claude Code",
          wsKind: "branch",
        },
        { id: "pane-2", kind: "terminal", sessionId: "session-2", label: "Terminal" },
      ],
      active: null,
      belowEditorRun: null,
    })
    const { router } = renderSidebar({
      "projects.list": () => [{ id: "sessions-project", name: "Alpha", repoPath: "/a" }],
    })
    await waitFor(() => expect(screen.getByTestId("project-session")).toBeTruthy())
    expect(screen.getByTestId("project-sessions").textContent).toContain("Claude Code")
    expect(screen.getByTestId("project-sessions").textContent).toContain("main")
    expect(screen.getByTestId("project-sessions").textContent).not.toContain("Terminal")

    fireEvent.click(screen.getByTestId("project-sessions-toggle"))
    expect(screen.queryByTestId("project-sessions")).toBeNull()

    fireEvent.click(screen.getByTestId("project-sessions-toggle"))
    fireEvent.click(screen.getByTestId("project-session"))
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/sessions-project"))
  })

  test("projects render in the persisted order, with new ids appended", async () => {
    window.localStorage.setItem("pi-lab.sidebar.projectOrder", JSON.stringify(["c", "a"]))
    renderSidebar({
      "projects.list": () => [
        { id: "a", name: "Alpha", repoPath: "/a" },
        { id: "b", name: "Beta", repoPath: "/b" },
        { id: "c", name: "Gamma", repoPath: "/c" },
      ],
    })
    await waitFor(() => expect(screen.getAllByTestId("project-item").length).toBe(3))

    const ids = screen
      .getAllByTestId("project-item")
      .map((el) => el.getAttribute("data-project-id"))
    // Stored ids first (c, a), then the not-yet-stored id (b) in natural order.
    expect(ids).toEqual(["c", "a", "b"])
  })

  test("the title-bar app icon is absent across all theme modes", async () => {
    for (const mode of ["light", "dark", "system"] as const) {
      window.localStorage.setItem("pi-lab.theme", mode)
      const { unmount } = renderSidebar()
      await waitFor(() => expect(screen.getByTestId("app-sidebar")).toBeTruthy())
      expect(screen.queryByTestId("sidebar-app-logo")).toBeNull()
      unmount()
    }
  })

  test("the title-bar app icon stays absent when the sidebar is collapsed", async () => {
    window.localStorage.setItem("pi-lab.sidebar.collapsed", "true")
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("app-sidebar")).toBeTruthy())

    expect(screen.getByTestId("app-sidebar").getAttribute("data-collapsed")).toBe("true")
    expect(screen.queryByTestId("sidebar-app-logo")).toBeNull()
  })

  test("keeps one accessible collapse control in the old logo position for both layouts", async () => {
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("sidebar-titlebar")).toBeTruthy())

    const titlebar = screen.getByTestId("sidebar-titlebar")
    const navBody = screen.getByTestId("sidebar-nav-body")
    const collapse = screen.getByRole("button", { name: "Collapse sidebar" })

    expect(screen.getAllByTestId("sidebar-collapse-toggle")).toHaveLength(1)
    expect(titlebar.contains(collapse)).toBe(true)
    expect(navBody.contains(collapse)).toBe(false)
    expect(titlebar.className).not.toContain("justify-center")
    expect(collapse.className).toContain("ml-auto")
    expect(collapse.className).toContain("app-no-drag")

    fireEvent.click(collapse)
    const expand = await screen.findByRole("button", { name: "Expand sidebar" })

    expect(screen.getAllByTestId("sidebar-collapse-toggle")).toHaveLength(1)
    expect(screen.getByTestId("sidebar-titlebar").contains(expand)).toBe(true)
    expect(screen.getByTestId("sidebar-nav-body").contains(expand)).toBe(false)
    expect(screen.getByTestId("sidebar-titlebar").className).toContain("justify-center")
    expect(expand.className).not.toContain("ml-auto")
    expect(expand.className).toContain("app-no-drag")
    expect(expand.getAttribute("aria-pressed")).toBe("true")
  })

  test("shows app-wide feature help for hovered and focused controls by default", async () => {
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("sidebar-feature-help")).toBeTruthy())

    expect(screen.getByTestId("sidebar-feature-help-description").textContent).toBe(
      "Hover over or focus a control to learn what it does.",
    )

    const cluster = screen
      .getAllByTestId("science-nav-item")
      .find((item) => item.getAttribute("data-science-tab") === "cluster")
    if (!cluster) throw new Error("Cluster nav item missing")

    fireEvent.pointerOver(cluster)
    expect(screen.getByTestId("sidebar-feature-help-label").textContent).toBe("Cluster")
    expect(screen.getByTestId("sidebar-feature-help-description").textContent).toBe(
      "Monitor compute machines from your SSH config, including reachability and hardware usage.",
    )

    fireEvent.pointerOut(cluster)
    expect(screen.getByTestId("sidebar-feature-help-description").textContent).toBe(
      "Hover over or focus a control to learn what it does.",
    )

    const collapse = screen.getByTestId("sidebar-collapse-toggle")
    fireEvent.focus(collapse)
    expect(screen.getByTestId("sidebar-feature-help-label").textContent).toBe("Collapse sidebar")
    expect(screen.getByTestId("sidebar-feature-help-description").textContent).toBe(
      "Collapse the sidebar to its compact icon rail",
    )
  })

  test("persists hiding feature help and leaves a compact restore control", async () => {
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("sidebar-feature-help")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "Hide feature help" }))
    expect(screen.queryByTestId("sidebar-feature-help")).toBeNull()
    expect(window.localStorage.getItem("pi-lab.sidebar.showFeatureHelp")).toBe("false")

    fireEvent.click(screen.getByRole("button", { name: "Show feature help" }))
    expect(screen.getByTestId("sidebar-feature-help")).toBeTruthy()
    expect(window.localStorage.getItem("pi-lab.sidebar.showFeatureHelp")).toBe("true")
  })

  test("keeps the feature-help card out of the collapsed icon rail", async () => {
    window.localStorage.setItem("pi-lab.sidebar.collapsed", "true")
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("app-sidebar")).toBeTruthy())

    expect(screen.queryByTestId("sidebar-feature-help")).toBeNull()
  })

  test("right-clicking a project opens a menu that removes it from the app", async () => {
    let removeInput: unknown
    renderSidebar({
      "projects.list": () => [{ id: "a", name: "Alpha", repoPath: "/a" }],
      "projects.remove": (input) => {
        removeInput = input
        return { id: "a", name: "Alpha", repoPath: "/a" }
      },
    })
    await waitFor(() => expect(screen.getByTestId("project-item")).toBeTruthy())

    // The menu only appears on right-click.
    expect(screen.queryByTestId("project-context-menu")).toBeNull()
    fireEvent.contextMenu(screen.getByTestId("project-item"))
    expect(screen.getByTestId("project-context-menu")).toBeTruthy()

    fireEvent.click(screen.getByTestId("project-remove"))
    await waitFor(() => expect(removeInput).toEqual({ id: "a" }))
    // Removing closes the menu.
    expect(screen.queryByTestId("project-context-menu")).toBeNull()
  })
})
