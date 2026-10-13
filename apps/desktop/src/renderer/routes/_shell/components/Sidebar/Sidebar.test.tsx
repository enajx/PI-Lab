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
import { ProjectActivityProvider } from "../../-ProjectActivity"
import { writeProjectWorkspaceState } from "../../projects/-workspaceState"
import { Sidebar } from "./Sidebar"

/**
 * Component test for the left sidebar (md/engineering/testing-and-build.md). Mounts the
 * real `Sidebar` under the app providers + a memory router (so its `<Link>`s
 * resolve) with a faked tRPC client. jsdom suffices — the sidebar is plain DOM
 * (no Radix). We cover the unified workspace nav (Workflows still reachable), the
 * persisted project ordering, and the Add-project dropdown including the
 * template-project details and Markdown-file chooser.
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
      <ProjectActivityProvider>
        {/* biome-ignore lint/suspicious/noExplicitAny: test router type plumbing. */}
        <RouterProvider router={router as any} />
      </ProjectActivityProvider>
    </AppProviders>,
  )
  return { ...result, router, queryClient }
}

describe("Sidebar", () => {
  // Reset persisted layout prefs (nav/project order) so tests don't bleed order.
  beforeEach(() => {
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  test("translates navigation and help after choosing Spanish", async () => {
    window.localStorage.setItem("pi-lab.interface.language", "es")
    renderSidebar()

    expect((await screen.findByTestId("nav-dashboard")).textContent).toContain("Panel de proyectos")
    expect(screen.getByTestId("sidebar-feature-help-description").textContent).toBe(
      "Pasa el cursor o enfoca un control para saber qué hace.",
    )
  })

  test("resizes from the inner edge when the interface is right-to-left", async () => {
    document.documentElement.dir = "rtl"
    renderSidebar()
    const handle = await screen.findByTestId("sidebar-edge-drag")
    Object.defineProperty(handle, "setPointerCapture", { value: vi.fn() })
    expect(handle.className).toContain("end-0")
    fireEvent(handle, new MouseEvent("pointerdown", { button: 0, clientX: 100, bubbles: true }))
    fireEvent(window, new MouseEvent("pointermove", { clientX: 60, bubbles: true }))
    expect(window.localStorage.getItem("pi-lab.sidebar.width")).toBe("280")
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }))
    document.documentElement.dir = "ltr"
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

  test("the template item collects a name, location, and selected Markdown files", async () => {
    let templateInput: unknown
    renderSidebar({
      "template.list": () => [
        { name: "AGENTS.md", relPath: "AGENTS.md", kind: "file" },
        { name: "TODO.md", relPath: "TODO.md", kind: "file" },
      ],
      "settings.get": () => ({
        projectTemplate: {
          initializationMarkdownFiles: ["AGENTS.md"],
          defaultTemplateParentPath: null,
        },
      }),
      "projects.createFromTemplate": (input) => {
        templateInput = input
        return { id: "tmpl", name: "tmpl", repoPath: "/tmp/projects/Study" }
      },
    })
    await waitFor(() => expect(screen.getByTestId("add-project")).toBeTruthy())

    fireEvent.click(screen.getByTestId("add-project"))
    fireEvent.click(screen.getByTestId("add-project-template"))

    expect(screen.getByTestId("add-project-template-form")).toBeTruthy()
    await screen.findByText("AGENTS.md")
    fireEvent.change(screen.getByTestId("add-project-template-name"), {
      target: { value: "Study" },
    })
    fireEvent.change(screen.getByTestId("add-project-template-location"), {
      target: { value: "/tmp/projects" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))

    await waitFor(() =>
      expect(templateInput).toEqual({
        targetDir: "/tmp/projects/Study",
        templateFiles: ["AGENTS.md"],
        externalFiles: [],
      }),
    )
  })

  test("clicking outside a template-file preview closes it", async () => {
    renderSidebar({
      "template.list": () => [{ name: "AGENTS.md", relPath: "AGENTS.md", kind: "file" }],
      "template.read": () => ({ exists: true, content: "# Agents" }),
      "settings.get": () => ({
        projectTemplate: {
          initializationMarkdownFiles: ["AGENTS.md"],
          defaultTemplateParentPath: null,
        },
      }),
    })
    await waitFor(() => expect(screen.getByTestId("add-project")).toBeTruthy())

    fireEvent.click(screen.getByTestId("add-project"))
    fireEvent.click(screen.getByTestId("add-project-template"))
    fireEvent.click(await screen.findByRole("button", { name: "AGENTS.md" }))

    const preview = await screen.findByRole("dialog", { name: "Preview AGENTS.md" })
    expect(preview).toBeTruthy()
    fireEvent.click(screen.getByTestId("template-file-preview-overlay"))

    expect(screen.queryByRole("dialog", { name: "Preview AGENTS.md" })).toBeNull()
  })

  test("a file added to one project instance does not change the Settings template", async () => {
    let createInput: unknown
    let templateSettingsWrites = 0
    renderSidebar({
      "template.list": () => [{ name: "AGENTS.md", relPath: "AGENTS.md", kind: "file" }],
      "settings.get": () => ({
        projectTemplate: {
          initializationMarkdownFiles: ["AGENTS.md"],
          defaultTemplateParentPath: null,
        },
      }),
      "system.pickFile": () => "/tmp/project-only.txt",
      "settings.updateProjectTemplate": () => {
        templateSettingsWrites += 1
        return {}
      },
      "projects.createFromTemplate": (input) => {
        createInput = input
        return { id: "instance", name: "instance", repoPath: "/tmp/projects/Instance" }
      },
    })
    await waitFor(() => expect(screen.getByTestId("add-project")).toBeTruthy())

    fireEvent.click(screen.getByTestId("add-project"))
    fireEvent.click(screen.getByTestId("add-project-template"))
    fireEvent.click(await screen.findByRole("button", { name: "Add file" }))
    await screen.findByText("project-only.txt")
    fireEvent.change(screen.getByTestId("add-project-template-name"), {
      target: { value: "Instance" },
    })
    fireEvent.change(screen.getByTestId("add-project-template-location"), {
      target: { value: "/tmp/projects" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))

    await waitFor(() =>
      expect(createInput).toEqual({
        targetDir: "/tmp/projects/Instance",
        templateFiles: ["AGENTS.md"],
        externalFiles: ["/tmp/project-only.txt"],
      }),
    )
    expect(templateSettingsWrites).toBe(0)
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

  test.each([
    "unsaved",
    "conflicted",
  ] as const)("marks a project with %s open-file edits and clears the marker after save", async (state) => {
    writeProjectWorkspaceState("a", {
      buffers: [
        {
          relPath: "notes.md",
          content: state === "unsaved" ? "draft" : "saved",
          savedContent: "saved",
          baseline: { mtimeMs: 1, size: 5 },
          externalChange: state === "conflicted",
          epoch: 0,
        },
      ],
      activeRelPath: "notes.md",
      sessions: [],
      active: { type: "file", relPath: "notes.md" },
      belowEditorRun: null,
    })
    const { unmount } = renderSidebar({
      "projects.list": () => [{ id: "a", name: "Alpha", repoPath: "/a" }],
    })
    await waitFor(() => expect(screen.getByTestId("project-unsaved-edits")).toBeTruthy())
    unmount()

    writeProjectWorkspaceState("a", {
      buffers: [
        {
          relPath: "notes.md",
          content: "saved",
          savedContent: "saved",
          baseline: { mtimeMs: 1, size: 5 },
          externalChange: false,
          epoch: 0,
        },
      ],
      activeRelPath: "notes.md",
      sessions: [],
      active: { type: "file", relPath: "notes.md" },
      belowEditorRun: null,
    })
    renderSidebar({ "projects.list": () => [{ id: "a", name: "Alpha", repoPath: "/a" }] })
    await waitFor(() => expect(screen.queryByTestId("project-unsaved-edits")).toBeNull())
  })

  test("an expanded project row uses its thumbnail as the project badge", async () => {
    const thumbnailRequests: unknown[] = []
    const { container } = renderSidebar({
      "projects.list": () => [
        {
          id: "a",
          name: "Alpha",
          repoPath: "/a",
          hasThumbnail: true,
        },
      ],
      "projects.thumbnail": (input) => {
        thumbnailRequests.push(input)
        return { dataUrl: "data:image/png;base64,AA==", tooLarge: false }
      },
    })
    await waitFor(() => expect(screen.getByTestId("project-item")).toBeTruthy())

    await waitFor(() => {
      const thumbnail = container.querySelector('[data-testid="project-sessions-toggle"] img')
      expect(thumbnail?.getAttribute("src")).toBe("data:image/png;base64,AA==")
    })
    expect(thumbnailRequests).toEqual([{ id: "a", variant: "badge" }])
  })

  test("clearing artwork hides a cached badge when the list flag becomes false", async () => {
    let hasThumbnail = true
    const { container, queryClient } = renderSidebar({
      "projects.list": () => [{ id: "a", name: "Alpha", repoPath: "/a", hasThumbnail }],
      "projects.thumbnail": () => ({ dataUrl: "data:image/png;base64,AA==", tooLarge: false }),
    })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="project-sessions-toggle"] img')).not.toBeNull()
    })
    hasThumbnail = false
    await queryClient.invalidateQueries()
    await waitFor(() => {
      expect(container.querySelector('[data-testid="project-sessions-toggle"] img')).toBeNull()
    })
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

  test("hides archived projects in both sidebar layouts and can reveal and restore them", async () => {
    let projects = [
      { id: "visible", name: "Visible", repoPath: "/visible", archivedAt: null },
      { id: "hidden", name: "Hidden", repoPath: "/hidden", archivedAt: 123 },
    ]
    const archivedCalls: unknown[] = []
    const rendered = renderSidebar({
      "projects.list": () => projects,
      "projects.setArchived": (input) => {
        archivedCalls.push(input)
        const { id, archived } = input as { id: string; archived: boolean }
        projects = projects.map((row) =>
          row.id === id ? { ...row, archivedAt: archived ? Date.now() : null } : row,
        )
        return projects.find((row) => row.id === id)
      },
    })

    await screen.findByText("Visible")
    expect(screen.queryByText("Hidden")).toBeNull()
    fireEvent.click(screen.getByTestId("sidebar-show-hidden-projects"))
    const revealed = await screen.findByText("Hidden")
    const revealedRow = revealed.closest('[data-testid="project-item"]')
    expect(revealedRow?.getAttribute("data-hidden")).toBe("true")
    expect(revealedRow?.className).toContain("opacity-60")

    fireEvent.contextMenu(revealed)
    fireEvent.click(screen.getByTestId("project-restore"))
    await waitFor(() => expect(archivedCalls).toEqual([{ id: "hidden", archived: false }]))
    await waitFor(() => expect(screen.queryByTestId("sidebar-show-hidden-projects")).toBeNull())

    rendered.unmount()
    window.localStorage.setItem("pi-lab.sidebar.collapsed", "true")
    projects = projects.map((row) =>
      row.id === "hidden" ? { ...row, archivedAt: Date.now() } : row,
    )
    renderSidebar({ "projects.list": () => projects })
    await screen.findByTitle("Visible")
    expect(screen.queryByTitle("Hidden")).toBeNull()
    expect(screen.getByTestId("sidebar-show-hidden-projects").getAttribute("aria-label")).toBe(
      "Show hidden projects (1)",
    )
    fireEvent.click(screen.getByTestId("sidebar-show-hidden-projects"))
    expect((await screen.findByTitle("Hidden")).getAttribute("data-hidden")).toBe("true")
  })

  test("a project context menu hides a project without removing it", async () => {
    let projects: Array<{
      id: string
      name: string
      repoPath: string
      archivedAt: number | null
    }> = [{ id: "a", name: "Alpha", repoPath: "/a", archivedAt: null }]
    const archivedCalls: unknown[] = []
    renderSidebar({
      "projects.list": () => projects,
      "projects.setArchived": (input) => {
        archivedCalls.push(input)
        projects = projects.map((row) => ({ ...row, archivedAt: Date.now() }))
        return projects[0]
      },
    })
    fireEvent.contextMenu(await screen.findByTestId("project-item"))
    fireEvent.click(screen.getByTestId("project-hide"))

    await waitFor(() => expect(archivedCalls).toEqual([{ id: "a", archived: true }]))
    await waitFor(() => expect(screen.queryByTestId("project-item")).toBeNull())
    expect(screen.getByTestId("sidebar-show-hidden-projects")).toBeTruthy()
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
    expect(collapse.className).toContain("ms-auto")
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
