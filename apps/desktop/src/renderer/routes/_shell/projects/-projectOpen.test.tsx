import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { useShowFilesPanel } from "../../../preferences/preferences"
import { AppProviders } from "../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../test/fakeTrpcClient"
// StrictMode-wrapped render (see test/render.tsx) — reproduces the dev build's
// effect double-invoke, which is what surfaced the "Opening project…" hang.
import { act, render, screen, waitFor } from "../../../test/render"
import { ProjectWorkspace } from "./-ProjectWorkspace"
import { clearPendingOpenFile, setPendingOpenFile } from "./-pendingOpenFile"
import {
  readProjectWorkspaceState,
  writeProjectWorkspaceState,
  writeProjectWorkspaceViewState,
} from "./-workspaceState"

const { openFile } = vi.hoisted(() => ({ openFile: vi.fn() }))

// Isolate the OPEN flow (does the project view finish opening?) from the central
// panel / sidebar internals by stubbing the heavy children. This test renders
// under <StrictMode>, which — like the dev build the user actually runs, and
// unlike the production e2e build — double-invokes effects. A StrictMode-unsafe
// "fire once" ensureMain effect leaves workspaceId unset and the view stuck on
// "Opening project…"; this test fails in that case and passes once the effect
// applies the result from its still-active run.
vi.mock("./components/CentralPanel", () => ({
  CentralPanel: ({
    openFileFinder,
    filesPanelOpen,
    onFilesPanelOpenChange,
  }: {
    openFileFinder: boolean
    filesPanelOpen: boolean
    onFilesPanelOpenChange: (open: boolean) => void
  }) => (
    <div
      data-testid="central-panel-stub"
      data-open-file-finder={String(openFileFinder)}
      data-files-panel-open={String(filesPanelOpen)}
    >
      <button
        type="button"
        data-testid="files-toggle-stub"
        onClick={() => onFilesPanelOpenChange(!filesPanelOpen)}
      />
    </div>
  ),
  useCentralPanel: () => ({
    attachSession: () => {},
    openFile,
    editor: { active: null },
  }),
}))
vi.mock("./components/RightSidebar", () => ({
  FILES_TAB_ID: "files",
  RightSidebar: ({ activeId }: { activeId: string | null }) => (
    <div data-testid="right-sidebar-stub" data-active-id={activeId ?? ""} />
  ),
}))
vi.mock("./components/ProjectPalette", () => ({ ProjectPalette: () => null }))

function renderWorkspaceUnderStrictMode(handlers: FakeHandlers, projectId = "p1") {
  const client = createFakeTrpcClient({
    "caffeine.status": () => ({ mode: "off", scope: "system-only", held: false }),
    "projects.get": () => ({ id: "p1", name: "Photon Drift", repoPath: "/tmp/photon-drift" }),
    "settings.get": () => ({}),
    // The real ensureMain is idempotent; here it resolves to the main workspace.
    "workspaces.ensureMain": () => ({ id: "w1" }),
    ...handlers,
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ProjectWorkspace projectId={projectId} activation={{}} />
    </AppProviders>,
  )
}

/** The real central panel seeds each project's workspace state on mount; the stub does not. */
function seedProject(projectId: string) {
  writeProjectWorkspaceState(projectId, {
    buffers: [],
    activeRelPath: null,
    sessions: [],
    active: null,
    belowEditorRun: null,
  })
}

/** Change the global left-column default through its real preference hook. */
let setGlobalFilesPanel: (open: boolean) => void = () => {
  throw new Error("GlobalFilesPanelSetter is not mounted")
}
function GlobalFilesPanelSetter() {
  const [, setShowFilesPanel] = useShowFilesPanel()
  setGlobalFilesPanel = setShowFilesPanel
  return null
}

beforeEach(() => {
  render(<GlobalFilesPanelSetter />)
})

afterEach(() => {
  clearPendingOpenFile("p1")
  openFile.mockClear()
  window.localStorage.clear()
})

describe("Project open", () => {
  test("resolves the main workspace and shows the project view under StrictMode", async () => {
    renderWorkspaceUnderStrictMode({})

    // The open flow must complete: the central panel mounts and the
    // "Opening project…" gate is gone.
    expect(await screen.findByTestId("central-panel-stub")).toBeTruthy()
    expect(screen.queryByText("Opening project…")).toBeNull()
  })

  test("a project without a saved tab opens on Files; a saved tab is restored", async () => {
    seedProject("p-tab-new")
    const fresh = renderWorkspaceUnderStrictMode({}, "p-tab-new")
    expect((await screen.findByTestId("right-sidebar-stub")).dataset.activeId).toBe("files")
    fresh.unmount()

    seedProject("p-tab-saved")
    writeProjectWorkspaceViewState("p-tab-saved", {
      rightSidebarCollapsed: false,
      rightSidebarActiveId: "todos",
      pinnedPanels: [],
      filesPanelOpen: undefined,
    })
    renderWorkspaceUnderStrictMode({}, "p-tab-saved")
    expect((await screen.findByTestId("right-sidebar-stub")).dataset.activeId).toBe("todos")
  })

  test("the old global Files-column switch value does not open the column", async () => {
    // Before the per-project override, this key turned the column on everywhere.
    window.localStorage.setItem("pi-lab.projectView.showFilesPanel", "true")
    seedProject("p-old-key")
    renderWorkspaceUnderStrictMode({}, "p-old-key")
    const panel = await screen.findByTestId("central-panel-stub")
    expect(panel.dataset.filesPanelOpen).toBe("false")
  })

  test("a project without its own left-column value follows the global default live", async () => {
    seedProject("p-global")
    setGlobalFilesPanel(true)
    renderWorkspaceUnderStrictMode({}, "p-global")
    const panel = await screen.findByTestId("central-panel-stub")
    expect(panel.dataset.filesPanelOpen).toBe("true")

    act(() => setGlobalFilesPanel(false))
    expect(screen.getByTestId("central-panel-stub").dataset.filesPanelOpen).toBe("false")
    act(() => setGlobalFilesPanel(true))
    expect(screen.getByTestId("central-panel-stub").dataset.filesPanelOpen).toBe("true")
  })

  test("toggling the left column in a project stores its own value, kept over the global default", async () => {
    seedProject("p-own-a")
    seedProject("p-own-b")
    setGlobalFilesPanel(false)
    const first = renderWorkspaceUnderStrictMode({}, "p-own-a")
    expect((await screen.findByTestId("central-panel-stub")).dataset.filesPanelOpen).toBe("false")
    act(() => screen.getByTestId("files-toggle-stub").click())
    expect(screen.getByTestId("central-panel-stub").dataset.filesPanelOpen).toBe("true")
    expect(readProjectWorkspaceState("p-own-a", true)?.filesPanelOpen).toBe(true)

    // A later global change does not move A, which now has its own value.
    act(() => setGlobalFilesPanel(false))
    expect(screen.getByTestId("central-panel-stub").dataset.filesPanelOpen).toBe("true")
    first.unmount()

    // B has no value of its own and follows the global default.
    act(() => setGlobalFilesPanel(true))
    const second = renderWorkspaceUnderStrictMode({}, "p-own-b")
    expect((await screen.findByTestId("central-panel-stub")).dataset.filesPanelOpen).toBe("true")
    expect(readProjectWorkspaceState("p-own-b", true)?.filesPanelOpen).toBeUndefined()
    second.unmount()

    // A reopens with its own value although the global default is now on and was off.
    act(() => setGlobalFilesPanel(false))
    renderWorkspaceUnderStrictMode({}, "p-own-a")
    expect((await screen.findByTestId("central-panel-stub")).dataset.filesPanelOpen).toBe("true")
  })

  test("opens every globally created file while the chosen project is already mounted", async () => {
    renderWorkspaceUnderStrictMode({})
    await screen.findByTestId("central-panel-stub")

    act(() => setPendingOpenFile("p1", "notes/first.md"))
    await waitFor(() => expect(openFile).toHaveBeenCalledWith("notes/first.md"))

    act(() => setPendingOpenFile("p1", "notes/second.md"))
    await waitFor(() => {
      expect(openFile).toHaveBeenCalledTimes(2)
      expect(openFile).toHaveBeenLastCalledWith("notes/second.md")
    })
  })

  test("keeps file search requested before the workspace is ready", async () => {
    let resolveWorkspace!: (value: { id: string }) => void
    const pendingWorkspace = new Promise<{ id: string }>((resolve) => {
      resolveWorkspace = resolve
    })
    renderWorkspaceUnderStrictMode({
      "workspaces.ensureMain": () => pendingWorkspace,
    })

    await screen.findByTestId("project-view")
    expect(screen.queryByTestId("central-panel-stub")).toBeNull()
    act(() => window.dispatchEvent(new Event("pi-lab:open-project-file-finder")))

    await act(async () => resolveWorkspace({ id: "w1" }))
    expect((await screen.findByTestId("central-panel-stub")).dataset.openFileFinder).toBe("true")
  })
})
