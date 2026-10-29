import { QueryClient } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { useState } from "react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../providers/AppProviders"
import { createFakeTrpcClient } from "../../test/fakeTrpcClient"
import { fireEvent, render, screen } from "../../test/render"
import { useGlobalShortcuts } from "./-globalShortcuts"
import type { CentralPanelController } from "./projects/components/CentralPanel"
import { ProjectPalette } from "./projects/components/ProjectPalette"

/**
 * Which palette ⌘P and ⇧⌘P open. The root route mirrors `_shell.tsx` (the global
 * shortcut hook plus a stand-in for the lazy global palette) and the project route
 * mounts the real project palette, as `-ProjectWorkspace.tsx` does once the project
 * is ready. "/" is a Dashboard stand-in.
 */
function renderShell(initialPath: string) {
  const client = createFakeTrpcClient({
    "files.read": () => ({ status: "text", exists: true, content: "# Research\n" }),
    "files.tree": () => [],
    "workspaces.changes": () => [],
    "science.skills.list": () => ({ skills: [], roots: [] }),
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: function ShellStandIn() {
      const [paletteOpen, setPaletteOpen] = useState(false)
      useGlobalShortcuts("/", {}, () => setPaletteOpen(true))
      return (
        <>
          <Outlet />
          {paletteOpen ? <div data-testid="global-palette" /> : null}
        </>
      )
    },
  })
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="dashboard" />,
  })
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId",
    component: () => (
      <>
        <div data-testid="project-palette-ready" />
        <ProjectPalette
          controller={
            {
              openAgentChooser: vi.fn(),
              openTerminal: vi.fn(),
              openFile: vi.fn(),
            } as unknown as CentralPanelController
          }
          workspaceId="ws-1"
          pinnedPanels={[]}
          filesPanelOpen={false}
          onSelectPanel={() => {}}
        />
      </>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([dashboardRoute, projectRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      {/* biome-ignore lint/suspicious/noExplicitAny: test router type plumbing. */}
      <RouterProvider router={router as any} />
    </AppProviders>,
  )
}

function projectPaletteOpen(): boolean {
  return screen.queryByRole("dialog", { name: "Project command palette" }) !== null
}

beforeEach(() => {
  window.localStorage.clear()
})

describe("palette shortcuts", () => {
  test("⌘P in a project opens the project palette, not the global one", async () => {
    renderShell("/projects/p1")
    await screen.findByTestId("project-palette-ready")
    fireEvent.keyDown(window, { key: "p", metaKey: true })
    expect(projectPaletteOpen()).toBe(true)
    expect(screen.queryByTestId("global-palette")).toBeNull()
  })

  test("⌘P in a terminal inside a project still opens the project palette", async () => {
    renderShell("/projects/p1")
    await screen.findByTestId("project-palette-ready")
    const terminal = document.createElement("div")
    terminal.className = "xterm"
    const input = document.createElement("textarea")
    terminal.appendChild(input)
    document.body.appendChild(terminal)
    // xterm and CodeMirror may stop propagation of keys they handle.
    input.addEventListener("keydown", (event) => event.stopPropagation())
    input.focus()
    fireEvent.keyDown(input, { key: "p", metaKey: true })
    terminal.remove()
    expect(projectPaletteOpen()).toBe(true)
    expect(screen.queryByTestId("global-palette")).toBeNull()
  })

  test("⇧⌘P in a project opens the global palette, not the project one", async () => {
    renderShell("/projects/p1")
    await screen.findByTestId("project-palette-ready")
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
    expect(screen.getByTestId("global-palette")).toBeTruthy()
    expect(projectPaletteOpen()).toBe(false)
  })

  test("⌘P on the Dashboard opens the global palette", async () => {
    renderShell("/")
    await screen.findByTestId("dashboard")
    fireEvent.keyDown(window, { key: "p", metaKey: true })
    expect(screen.getByTestId("global-palette")).toBeTruthy()
  })

  test("⇧⌘P on the Dashboard opens the global palette", async () => {
    renderShell("/")
    await screen.findByTestId("dashboard")
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
    expect(screen.getByTestId("global-palette")).toBeTruthy()
  })
})
