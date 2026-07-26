import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../test/fakeTrpcClient"
// StrictMode-wrapped render (see test/render.tsx) — reproduces the dev build's
// effect double-invoke, which is what surfaced the "Opening project…" hang.
import { act, render, screen, waitFor } from "../../../test/render"
import { clearPendingOpenFile, setPendingOpenFile } from "./-pendingOpenFile"
import { ProjectWorkspace } from "./$projectId"

const { openFile } = vi.hoisted(() => ({ openFile: vi.fn() }))

// Isolate the OPEN flow (does the project view finish opening?) from the central
// panel / sidebar internals by stubbing the heavy children. This test renders
// under <StrictMode>, which — like the dev build the user actually runs, and
// unlike the production e2e build — double-invokes effects. A StrictMode-unsafe
// "fire once" ensureMain effect leaves workspaceId unset and the view stuck on
// "Opening project…"; this test fails in that case and passes once the effect
// applies the result from its still-active run.
vi.mock("./components/CentralPanel", () => ({
  CentralPanel: () => <div data-testid="central-panel-stub" />,
  useCentralPanel: () => ({
    attachSession: () => {},
    openFile,
    editor: { active: null },
  }),
}))
vi.mock("./components/RightSidebar", () => ({
  RightSidebar: () => <div data-testid="right-sidebar-stub" />,
}))
vi.mock("./components/ProjectPalette", () => ({ ProjectPalette: () => null }))

function renderWorkspaceUnderStrictMode() {
  const client = createFakeTrpcClient({
    "caffeine.status": () => ({ mode: "off", scope: "system-only", held: false }),
    "projects.get": () => ({ id: "p1", name: "Photon Drift", repoPath: "/tmp/photon-drift" }),
    "settings.get": () => ({}),
    // The real ensureMain is idempotent; here it resolves to the main workspace.
    "workspaces.ensureMain": () => ({ id: "w1" }),
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ProjectWorkspace projectId="p1" activation={{}} />
    </AppProviders>,
  )
}

afterEach(() => {
  clearPendingOpenFile("p1")
  openFile.mockClear()
})

describe("Project open", () => {
  test("resolves the main workspace and shows the project view under StrictMode", async () => {
    renderWorkspaceUnderStrictMode()

    // The open flow must complete: the central panel mounts and the
    // "Opening project…" gate is gone.
    expect(await screen.findByTestId("central-panel-stub")).toBeTruthy()
    expect(screen.queryByText("Opening project…")).toBeNull()
  })

  test("opens every globally created file while the chosen project is already mounted", async () => {
    renderWorkspaceUnderStrictMode()
    await screen.findByTestId("central-panel-stub")

    act(() => setPendingOpenFile("p1", "notes/first.md"))
    await waitFor(() => expect(openFile).toHaveBeenCalledWith("notes/first.md"))

    act(() => setPendingOpenFile("p1", "notes/second.md"))
    await waitFor(() => {
      expect(openFile).toHaveBeenCalledTimes(2)
      expect(openFile).toHaveBeenLastCalledWith("notes/second.md")
    })
  })
})
