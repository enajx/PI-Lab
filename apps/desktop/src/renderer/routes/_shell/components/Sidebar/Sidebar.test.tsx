import { QueryClient } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../providers/AppProviders"
import { closeQuickBuffer, writeQuickBuffer } from "../../../../QuickEditor/quickEditorState"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../test/fakeTrpcClient"
import { ProjectActivityProvider } from "../../-ProjectActivity"
import { writeProjectWorkspaceState } from "../../projects/-workspaceState"
import { SectionsSection } from "../../settings/components/SettingsSections"
import { FEATURE_HELP_CONTROLS, FeatureHelpPanel, Sidebar, sameHelpText } from "./Sidebar"

describe("sameHelpText", () => {
  test("treats case, spacing, and trailing punctuation as the same text", () => {
    expect(sameHelpText("Add or remove header shortcuts", "add or remove  header shortcuts.")).toBe(
      true,
    )
    expect(sameHelpText("Header shortcuts", "Choose which buttons this top bar shows.")).toBe(false)
  })
})

/**
 * Component test for the left sidebar. Mounts the
 * real `Sidebar` under the app providers + a memory router (so its `<Link>`s
 * resolve) with a faked tRPC client. jsdom suffices — the sidebar is plain DOM
 * (no Radix). We cover the unified workspace nav (Workflows still reachable), the
 * persisted project ordering, and the Add-project dropdown including the
 * template-project details and Markdown-file chooser.
 */

function renderSidebar(handlers: FakeHandlers = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "projects.list": () => [],
    "agents.list": () => [],
    ...handlers,
  })

  // A handful of stub routes so the sidebar's `<Link>` targets resolve.
  const rootRoute = createRootRoute({ component: Sidebar })
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      stub("/projects/$projectId"),
      stub("/automations"),
      stub("/quick-edit"),
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
    await screen.findByTestId("add-project-dialog")
    fireEvent.click(screen.getByTestId("add-project-confirm"))

    await waitFor(() =>
      expect(templateInput).toEqual({
        targetDir: "/tmp/projects/Study",
        details: {
          name: "Study",
          typeId: "general",
          deadline: null,
          agentId: null,
          emojiTags: [],
          textTags: [],
        },
        templateFiles: ["AGENTS.md"],
        externalFiles: [],
      }),
    )
  })

  test("an empty default selection does not copy imported template files", async () => {
    let templateInput: unknown
    renderSidebar({
      "template.list": () => [{ name: "AGENTS.md", relPath: "AGENTS.md", kind: "file" }],
      "settings.get": () => ({
        projectTemplate: {
          initializationMarkdownFiles: [],
          defaultTemplateParentPath: null,
        },
      }),
      "projects.createFromTemplate": (input) => {
        templateInput = input
        return { id: "empty", name: "empty", repoPath: "/tmp/projects/Empty" }
      },
    })
    await screen.findByTestId("add-project")
    fireEvent.click(screen.getByTestId("add-project"))
    fireEvent.click(screen.getByTestId("add-project-template"))
    await screen.findByTestId("add-project-template-form")
    fireEvent.change(screen.getByTestId("add-project-template-name"), {
      target: { value: "Empty" },
    })
    fireEvent.change(screen.getByTestId("add-project-template-location"), {
      target: { value: "/tmp/projects" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))
    await screen.findByTestId("add-project-dialog")
    fireEvent.click(screen.getByTestId("add-project-confirm"))
    await waitFor(() =>
      expect(templateInput).toEqual({
        targetDir: "/tmp/projects/Empty",
        details: {
          name: "Empty",
          typeId: "general",
          deadline: null,
          agentId: null,
          emojiTags: [],
          textTags: [],
        },
        templateFiles: [],
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
    await screen.findByTestId("add-project-dialog")
    fireEvent.click(screen.getByTestId("add-project-confirm"))

    await waitFor(() =>
      expect(createInput).toEqual({
        targetDir: "/tmp/projects/Instance",
        details: {
          name: "Instance",
          typeId: "general",
          deadline: null,
          agentId: null,
          emojiTags: [],
          textTags: [],
        },
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

  test("Routines is reachable inside the single workspace nav", async () => {
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("nav-automations")).toBeTruthy())

    const workflows = screen.getByTestId("nav-automations")
    expect(workflows.textContent).toContain("Routines")
    // Workflows shares the one nav with the science rows (not a separate block).
    expect(screen.getByTestId("science-nav").contains(workflows)).toBe(true)
    expect(screen.getAllByTestId("science-nav-item").length).toBeGreaterThan(0)
  })

  test("workspace nav uses the requested default order and hides Editor by default", async () => {
    renderSidebar()
    const nav = await screen.findByTestId("science-nav")
    expect([...nav.children].map((row) => row.getAttribute("data-science-tab"))).toEqual([
      "tasks",
      "library",
      "analysis",
      "latex",
      "skills",
      "workflows",
      "cluster",
    ])
    expect(screen.queryByTestId("nav-editor")).toBeNull()
  })

  test("the Sections setting shows Editor at the bottom, and it opens without a file", async () => {
    window.localStorage.setItem("pi-lab.sections.showEditor", "true")
    const { router } = renderSidebar()
    const nav = await screen.findByTestId("science-nav")
    const editor = screen.getByTestId("nav-editor")
    expect(nav.lastElementChild).toBe(editor)
    fireEvent.click(editor)
    await waitFor(() => expect(router.state.location.pathname).toBe("/quick-edit"))
  })

  test("a saved order that contains Editor does not make it visible", async () => {
    window.localStorage.setItem("pi-lab.sidebar.navOrder", JSON.stringify(["editor", "workflows"]))
    renderSidebar()
    await screen.findByTestId("science-nav")
    expect(screen.queryByTestId("nav-editor")).toBeNull()
  })

  test("Editor keeps its dragged position from a saved order when shown", async () => {
    window.localStorage.setItem("pi-lab.sections.showEditor", "true")
    window.localStorage.setItem("pi-lab.sidebar.navOrder", JSON.stringify(["editor", "workflows"]))
    renderSidebar()
    const nav = await screen.findByTestId("science-nav")
    expect(nav.firstElementChild).toBe(screen.getByTestId("nav-editor"))
    expect(nav.children[1]).toBe(screen.getByTestId("nav-automations"))
  })

  test("shown Editor goes to the bottom of an older saved order without it", async () => {
    window.localStorage.setItem("pi-lab.sections.showEditor", "true")
    window.localStorage.setItem(
      "pi-lab.sidebar.navOrder",
      JSON.stringify(["workflows", "library", "analysis"]),
    )
    renderSidebar()
    const nav = await screen.findByTestId("science-nav")
    expect(nav.lastElementChild).toBe(screen.getByTestId("nav-editor"))
  })

  test("Editor shows at the bottom while a file outside any project is open, and hides after", async () => {
    renderSidebar()
    const nav = await screen.findByTestId("science-nav")
    expect(screen.queryByTestId("nav-editor")).toBeNull()

    const target = { id: "outside-file", path: "/tmp/outside.txt" }
    act(() =>
      writeQuickBuffer({
        target,
        content: "x",
        savedContent: "x",
        baseline: { exists: true, mtimeMs: 1, size: 1 },
        epoch: 0,
        conflict: false,
      }),
    )
    const editor = await screen.findByTestId("nav-editor")
    expect(nav.lastElementChild).toBe(editor)

    act(() => closeQuickBuffer(target.id))
    await waitFor(() => expect(screen.queryByTestId("nav-editor")).toBeNull())
  })

  test("the active nav row is not bold", async () => {
    renderSidebar()
    const nav = await screen.findByTestId("science-nav")
    const row = [...nav.children].find((item) => item.getAttribute("data-science-tab") === "tasks")
    fireEvent.click(row?.querySelector("a") ?? (row as HTMLElement))
    await waitFor(() => expect(nav.querySelector(".bg-accent")).not.toBeNull())
    expect(nav.querySelector(".font-medium, .font-semibold, .font-bold")).toBeNull()
  })

  test("the LaTeX Editor row shows the stylised LaTeX logo", async () => {
    renderSidebar()
    const nav = await screen.findByTestId("science-nav")
    const row = [...nav.children].find((item) => item.getAttribute("data-science-tab") === "latex")
    expect(row?.querySelector('[data-testid="latex-logo"]')).not.toBeNull()
  })

  test("adds LaTeX Editor below Tasks in an older saved nav order", async () => {
    window.localStorage.setItem(
      "pi-lab.sidebar.navOrder",
      JSON.stringify(["library", "tasks", "analysis", "workflows", "editor"]),
    )
    renderSidebar()
    const nav = await screen.findByTestId("science-nav")
    const order = [...nav.children].map((row) => row.getAttribute("data-science-tab"))
    expect(order.indexOf("latex")).toBe(order.indexOf("tasks") + 1)
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

  test("the whole project row opens the project, and rows show no grab cursor on hover", async () => {
    const { router } = renderSidebar({
      "projects.list": () => [{ id: "a", name: "Alpha", repoPath: "/a" }],
    })
    const link = await screen.findByTestId("project-item")
    const row = screen.getByTestId("project-row")
    expect(row.contains(link)).toBe(true)
    // A click on the row outside the name (its padding or the status ring) still opens it.
    fireEvent.click(screen.getByTestId("project-agent-status"))
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/a"))
    // Dragging needs a held button and movement; hovering only shows a pointer.
    for (const element of [row, ...document.querySelectorAll("[draggable=true]")])
      expect(element.className).not.toContain("cursor-grab")
    expect(row.className).toContain("cursor-pointer")
  })

  test("a paper-only project's row opens it in the LaTeX Editor", async () => {
    const { router } = renderSidebar({
      "projects.list": () => [
        { id: "solo", name: "My paper", repoPath: "/p", metadata: { paperOnly: true } },
      ],
    })
    fireEvent.click(await screen.findByTestId("project-agent-status"))
    await waitFor(() => expect(router.state.location.pathname).toBe("/science/latex"))
    expect(router.state.location.search).toEqual({ projectId: "solo" })
  })

  test("a project’s sidebar ring reflects its active agent state", async () => {
    renderSidebar({
      "projects.list": () => [{ id: "a", name: "Alpha", repoPath: "/a" }],
      "sessions.onStatus": () => [{ projectId: "a", state: "working" }],
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

  test("projects render in the saved project order that the Dashboard also uses", async () => {
    // An old sidebar-only order left in local storage is ignored.
    window.localStorage.setItem("pi-lab.sidebar.projectOrder", JSON.stringify(["a", "b"]))
    renderSidebar({
      "projects.list": () => [
        { id: "c", name: "Gamma", repoPath: "/c" },
        { id: "a", name: "Alpha", repoPath: "/a" },
        { id: "b", name: "Beta", repoPath: "/b" },
      ],
    })
    await waitFor(() => expect(screen.getAllByTestId("project-item").length).toBe(3))

    const ids = screen
      .getAllByTestId("project-item")
      .map((el) => el.getAttribute("data-project-id"))
    expect(ids).toEqual(["c", "a", "b"])
  })

  test("dragging a project row saves the new order for every project, hidden ones included", async () => {
    let projects = [
      { id: "a", name: "Alpha", repoPath: "/a", archivedAt: null },
      { id: "h", name: "Hidden", repoPath: "/h", archivedAt: 1 },
      { id: "b", name: "Beta", repoPath: "/b", archivedAt: null },
    ]
    const reorderCalls: unknown[] = []
    renderSidebar({
      "projects.list": () => projects,
      "projects.reorder": (input) => {
        reorderCalls.push(input)
        const { ids } = input as { ids: string[] }
        projects = ids.flatMap((id) => projects.filter((row) => row.id === id))
        return undefined
      },
    })
    await waitFor(() => expect(screen.getAllByTestId("project-item").length).toBe(2))
    const alpha = screen.getByText("Alpha")
    const beta = screen.getByText("Beta")
    const dataTransfer = { effectAllowed: "", dropEffect: "" }
    // Drop Beta on the top half of Alpha: Beta goes before it.
    fireEvent.dragStart(beta, { dataTransfer })
    fireEvent.dragOver(alpha, { dataTransfer })
    fireEvent.drop(alpha, { dataTransfer })

    await waitFor(() => expect(reorderCalls).toEqual([{ ids: ["b", "h", "a"] }]))
    await waitFor(() =>
      expect(
        screen.getAllByTestId("project-item").map((el) => el.getAttribute("data-project-id")),
      ).toEqual(["b", "a"]),
    )
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

  test("shows a rejected project menu action and leaves the project visible", async () => {
    renderSidebar({
      "projects.list": () => [{ id: "keep", name: "Keep", repoPath: "/keep", archivedAt: null }],
      "projects.setArchived": () => Promise.reject(new Error("Visibility change failed")),
    })
    fireEvent.contextMenu(await screen.findByTestId("project-item"))
    fireEvent.click(screen.getByTestId("project-hide"))
    expect((await screen.findByRole("alert")).textContent).toContain("Visibility change failed")
    expect(screen.getByTestId("project-item")).toBeTruthy()
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

  test("the What's this? card never shows a body equal to its title for any sidebar control", async () => {
    window.localStorage.setItem("pi-lab.sidebar.showEditor", "true")
    renderSidebar({
      "projects.list": () => [{ id: "a", name: "Alpha", repoPath: "/a" }],
    })
    await screen.findByText("Alpha")
    const controls = Array.from(
      screen.getByTestId("app-sidebar").querySelectorAll<HTMLElement>(FEATURE_HELP_CONTROLS),
    )
    expect(controls.length).toBeGreaterThan(5)
    for (const control of controls) {
      fireEvent.pointerOver(control)
      const label = screen.getByTestId("sidebar-feature-help-label").textContent ?? ""
      const body = screen.queryByTestId("sidebar-feature-help-description")?.textContent ?? ""
      expect(sameHelpText(label, body), `${label} / ${body}`).toBe(false)
      fireEvent.pointerOut(control)
    }
  })

  test("a control with no separate description shows only its title", async () => {
    render(
      <AppProviders client={createFakeTrpcClient({})} queryClient={new QueryClient()}>
        <FeatureHelpPanel onHide={() => {}} />
        <button type="button" aria-label="Close file" title="Close file" />
        <button type="button">Save</button>
        <button
          type="button"
          aria-label="Add or remove header shortcuts"
          data-feature-help="Add or remove header shortcuts."
        />
      </AppProviders>,
    )
    for (const [name, label] of [
      [/Close file/, "Close file"],
      [/Save/, "Save"],
      [/Add or remove header shortcuts/, "Add or remove header shortcuts"],
    ] as const) {
      fireEvent.pointerOver(screen.getByRole("button", { name }))
      expect(screen.getByTestId("sidebar-feature-help-label").textContent).toBe(label)
      expect(screen.queryByTestId("sidebar-feature-help-description")).toBeNull()
    }
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

/** The workspace nav row for view entry `id`. */
function navRow(id: string): HTMLElement | undefined {
  const nav = screen.queryByTestId("science-nav")
  if (!nav) return undefined
  return [...nav.children].find((row) => row.getAttribute("data-science-tab") === id) as
    | HTMLElement
    | undefined
}

/** The labels and check states of the view-entry menu's list, in order. */
function menuEntries(): Array<{ label: string; checked: string | null }> {
  const menu = screen.getByTestId("sidebar-view-menu")
  return within(menu)
    .getAllByRole("menuitemcheckbox")
    .map((item) => ({
      label: item.textContent ?? "",
      checked: item.getAttribute("aria-checked"),
    }))
}

describe("Sidebar view-entry menu", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test("right-clicking a view entry opens a menu with Hide and every entry checked", async () => {
    renderSidebar()
    await screen.findByTestId("science-nav")
    expect(screen.queryByTestId("sidebar-view-menu")).toBeNull()

    fireEvent.contextMenu(navRow("library") as HTMLElement, { clientX: 40, clientY: 120 })
    const menu = screen.getByTestId("sidebar-view-menu")
    expect(menu.style.left).toBe("40px")
    expect(menu.style.top).toBe("120px")
    expect(within(menu).getByTestId("sidebar-view-menu-hide").textContent).toBe("Hide 'Library'")
    expect(menuEntries()).toEqual([
      { label: "Tasks", checked: "true" },
      { label: "Library", checked: "true" },
      { label: "Analysis", checked: "true" },
      { label: "LaTeX Editor", checked: "true" },
      { label: "Skills", checked: "true" },
      { label: "Routines", checked: "true" },
      { label: "Cluster", checked: "true" },
      { label: "Editor", checked: "false" },
    ])
    // Projects Dashboard is always shown, so it is not in the list.
    expect(menu.textContent).not.toContain("Dashboard")

    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByTestId("sidebar-view-menu")).toBeNull()
  })

  test("Hide removes the entry, it stays hidden after remount, and the list shows it again", async () => {
    const first = renderSidebar()
    await screen.findByTestId("science-nav")
    fireEvent.contextMenu(navRow("library") as HTMLElement)
    fireEvent.click(screen.getByTestId("sidebar-view-menu-hide"))
    expect(screen.queryByTestId("sidebar-view-menu")).toBeNull()
    expect(navRow("library")).toBeUndefined()
    first.unmount()

    renderSidebar()
    await screen.findByTestId("science-nav")
    expect(navRow("library")).toBeUndefined()

    fireEvent.contextMenu(navRow("tasks") as HTMLElement)
    expect(menuEntries().find((entry) => entry.label === "Library")?.checked).toBe("false")
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Library" }))
    expect(navRow("library")).toBeTruthy()
    // The saved order is kept: Library is back in its place.
    const nav = screen.getByTestId("science-nav")
    expect(nav.children[1]?.getAttribute("data-science-tab")).toBe("library")
  })

  test("hiding the entry you are on keeps you on that page", async () => {
    const { router } = renderSidebar()
    await screen.findByTestId("science-nav")
    fireEvent.click(navRow("library")?.closest("a") ?? (navRow("library") as HTMLElement))
    await waitFor(() => expect(router.state.location.pathname).toBe("/science/library"))
    fireEvent.contextMenu(navRow("library") as HTMLElement)
    fireEvent.click(screen.getByTestId("sidebar-view-menu-hide"))
    expect(navRow("library")).toBeUndefined()
    expect(router.state.location.pathname).toBe("/science/library")
  })

  test("Settings section toggles and the menu agree", async () => {
    renderSidebar()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders client={createFakeTrpcClient({})} queryClient={queryClient}>
        <SectionsSection />
      </AppProviders>,
    )
    await screen.findByTestId("science-nav")
    const analysisToggle = screen.getByTestId("settings-show-analysis-section")

    // Menu to Settings.
    fireEvent.contextMenu(navRow("analysis") as HTMLElement)
    fireEvent.click(screen.getByTestId("sidebar-view-menu-hide"))
    expect(analysisToggle.getAttribute("aria-checked")).toBe("false")

    // Settings to menu.
    fireEvent.click(analysisToggle)
    expect(navRow("analysis")).toBeTruthy()
    fireEvent.contextMenu(navRow("tasks") as HTMLElement)
    expect(menuEntries().find((entry) => entry.label === "Analysis")?.checked).toBe("true")
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Editor" }))
    expect(screen.getByTestId("settings-show-editor-section").getAttribute("aria-checked")).toBe(
      "true",
    )
  })
})

describe("Sidebar project menu: Edit project…", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test("opens the Edit project dialog with the project's details and saves through updateDetails", async () => {
    const alpha = {
      id: "a",
      name: "Alpha",
      repoPath: "/a",
      typeId: "software",
      metadata: { deadline: "2027-01-02", emojiTags: [], textTags: [] },
      agentConfig: null,
      archivedAt: null,
      hasThumbnail: false,
    }
    const calls: unknown[] = []
    const { queryClient } = renderSidebar({
      "projects.list": () => [alpha],
      "agents.projectChoice": () => ({ agentId: null }),
      "paper.get": () => ({ paper: null }),
      "projects.updateDetails": (input) => {
        calls.push(input)
        return alpha
      },
    })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    fireEvent.contextMenu(await screen.findByTestId("project-item"))
    const menu = screen.getByTestId("project-context-menu")
    const items = within(menu).getAllByRole("menuitem")
    expect(items[0]?.getAttribute("data-testid")).toBe("project-edit")
    expect(items[0]?.textContent).toBe("Edit project…")
    fireEvent.click(items[0] as HTMLElement)
    expect(screen.queryByTestId("project-context-menu")).toBeNull()

    const dialog = screen.getByTestId("edit-project-dialog")
    expect((within(dialog).getByTestId("edit-project-name") as HTMLInputElement).value).toBe(
      "Alpha",
    )
    expect((within(dialog).getByTestId("edit-project-type") as HTMLSelectElement).value).toBe(
      "software",
    )
    fireEvent.change(within(dialog).getByTestId("edit-project-name"), {
      target: { value: "Beta" },
    })
    await waitFor(() =>
      expect((within(dialog).getByTestId("edit-project-save") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    fireEvent.click(within(dialog).getByTestId("edit-project-save"))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({ id: "a", details: { name: "Beta", typeId: "software" } })
    await waitFor(() => expect(screen.queryByTestId("edit-project-dialog")).toBeNull())
    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey))
    expect(keys.some((key) => key.includes("list"))).toBe(true)
    expect(keys.some((key) => key.includes("thumbnail"))).toBe(true)
    expect(keys.some((key) => key.includes("projectChoice"))).toBe(true)
  })
})
