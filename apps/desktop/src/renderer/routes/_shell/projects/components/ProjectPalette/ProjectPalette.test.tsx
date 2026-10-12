import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import type { CentralPanelController } from "../CentralPanel"
import { RightSidebar } from "../RightSidebar"
import { ProjectPalette } from "./ProjectPalette"

/**
 * Integration test for the project-scoped command palette (⇧⌘P). It's mounted INSIDE
 * the project workspace alongside the right sidebar, so these tests wire both to one
 * shared `activeId` state — mirroring `$projectId.tsx` — and drive the palette through
 * its real keyboard trigger and the shared QuickFind/QuickOpen overlays. Covers: the
 * shortcut opening the palette (and being inert when the palette isn't mounted, e.g.
 * on the Dashboard), the four action kinds invoking the controller, and switching a
 * right-sidebar panel actually changing the active tab.
 */

function makeController(): CentralPanelController {
  return {
    openAgentChooser: vi.fn(),
    openTerminal: vi.fn(),
    openFile: vi.fn(),
  } as unknown as CentralPanelController
}

function baseHandlers(overrides: FakeHandlers = {}): FakeHandlers {
  return {
    "files.read": () => ({ status: "text", exists: true, content: "# Research\n" }),
    "files.tree": () => [{ name: "main.py", relPath: "main.py", kind: "file" as const }],
    "files.search": () => ({ hits: [{ relPath: "main.py" }], partial: false, skipped: [] }),
    "workspaces.changes": () => [],
    "science.skills.list": () => ({ skills: [], roots: [] }),
    ...overrides,
  }
}

function Harness({
  controller,
  mountPalette = true,
}: {
  controller: CentralPanelController
  mountPalette?: boolean
}) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div>
      {collapsed ? null : (
        <RightSidebar
          projectId="p1"
          workspaceId="ws-1"
          onOpenFile={controller.openFile}
          activeId={activeId}
          onActiveIdChange={setActiveId}
          onCollapse={() => setCollapsed(true)}
          pinnedPanels={[]}
        />
      )}
      {mountPalette ? (
        <ProjectPalette
          controller={controller}
          workspaceId="ws-1"
          pinnedPanels={[]}
          onSelectPanel={(panelId) => {
            setActiveId(panelId)
            setCollapsed(false)
          }}
        />
      ) : null}
    </div>
  )
}

function renderHarness(controller: CentralPanelController, mountPalette = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(baseHandlers())
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <Harness controller={controller} mountPalette={mountPalette} />
    </AppProviders>,
  )
}

function pressPalette() {
  fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true })
}

beforeEach(() => {
  window.localStorage.clear()
})

describe("ProjectPalette", () => {
  test("⇧⌘P opens the project palette and lists the action kinds", () => {
    renderHarness(makeController())
    expect(screen.queryByTestId("quick-find")).toBeNull()

    pressPalette()

    expect(screen.getByTestId("quick-find")).toBeTruthy()
    expect(screen.getByText("Open agent")).toBeTruthy()
    expect(screen.getByText("Open terminal")).toBeTruthy()
    expect(screen.getByText("Open file…")).toBeTruthy()
    expect(screen.getByText("Switch to Research panel")).toBeTruthy()
    expect(screen.getByText("Switch to TODOs panel")).toBeTruthy()
    expect(screen.getByText("Switch to Files panel")).toBeTruthy()
  })

  test("⇧⌘P is inert when the palette is not mounted (e.g. the Dashboard)", () => {
    renderHarness(makeController(), false)
    pressPalette()
    expect(screen.queryByTestId("quick-find")).toBeNull()
  })

  test("selecting Open agent invokes the controller's agent chooser", () => {
    const controller = makeController()
    renderHarness(controller)
    pressPalette()
    fireEvent.click(screen.getByText("Open agent"))
    expect(controller.openAgentChooser).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("quick-find")).toBeNull()
  })

  test("selecting Open terminal invokes the controller's terminal action", () => {
    const controller = makeController()
    renderHarness(controller)
    pressPalette()
    fireEvent.click(screen.getByText("Open terminal"))
    expect(controller.openTerminal).toHaveBeenCalledTimes(1)
  })

  test("Open file… opens the fuzzy picker, and choosing a file opens it via the controller", async () => {
    const controller = makeController()
    renderHarness(controller)
    pressPalette()
    fireEvent.click(screen.getByText("Open file…"))

    // The command palette closes and the shared file picker takes over.
    expect(screen.queryByTestId("quick-find")).toBeNull()
    fireEvent.change(screen.getByTestId("quick-open-input"), { target: { value: "main" } })
    fireEvent.click(await screen.findByTestId("quick-open-result"))

    expect(controller.openFile).toHaveBeenCalledWith("main.py")
    expect(screen.queryByTestId("quick-open")).toBeNull()
  })

  test("switching a panel changes the active right-sidebar tab", () => {
    renderHarness(makeController())
    // Research (the first tab) is active by default.
    expect(screen.getByTestId("panel-tab-research").getAttribute("data-active")).toBe("true")
    expect(screen.getByTestId("panel-tab-todos").getAttribute("data-active")).toBe("false")

    pressPalette()
    fireEvent.click(screen.getByText("Switch to TODOs panel"))

    expect(screen.getByTestId("panel-tab-todos").getAttribute("data-active")).toBe("true")
    expect(screen.getByTestId("panel-tab-research").getAttribute("data-active")).toBe("false")
  })
})
