import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { RightSidebar } from "./RightSidebar"

/**
 * Component test for the project view's right sidebar (plan "Settings panel,
 * project-view rework"): Research / TODOs / Files are always present, Status is
 * gone, and the Code changes panel is hidden by default but revealed (and
 * persisted) via the gear's View-options menu. Files opens into the central
 * panel via `onOpenFile`. The collapse button writes the shared
 * `projectView.rightSidebarCollapsed` preference, which the project route reads
 * to drop the sidebar (mirrored by {@link CollapsibleHarness} here).
 */

function renderSidebar(onOpenFile = vi.fn(), overrides: FakeHandlers = {}) {
  const onCollapse = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "files.read": () => ({ exists: true, content: "# Research\n" }),
    "files.tree": () => [{ name: "main.py", relPath: "main.py", kind: "file" as const }],
    "workspaces.changes": () => [],
    ...overrides,
  })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <RightSidebar workspaceId="ws-1" onOpenFile={onOpenFile} onCollapse={onCollapse} />
    </AppProviders>,
  )
  return { onOpenFile, onCollapse }
}

/**
 * Stand-in for the project route's layout: the route owns the
 * `projectView.rightSidebarCollapsed` preference, rendering the sidebar (wired to
 * its `onCollapse`) only when expanded and a small expand affordance when collapsed.
 */
function CollapsibleHarness({ onOpenFile = vi.fn() }: { onOpenFile?: () => void }) {
  const [collapsed, setCollapsed] = useState(false)
  return collapsed ? (
    <button
      type="button"
      data-testid="right-sidebar-expand"
      aria-label="Expand panel"
      onClick={() => setCollapsed(false)}
    >
      expand
    </button>
  ) : (
    <RightSidebar
      workspaceId="ws-1"
      onOpenFile={onOpenFile}
      onCollapse={() => setCollapsed(true)}
    />
  )
}

function renderCollapsible() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "files.read": () => ({ exists: true, content: "# Research\n" }),
    "files.tree": () => [{ name: "main.py", relPath: "main.py", kind: "file" as const }],
    "workspaces.changes": () => [],
  })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <CollapsibleHarness />
    </AppProviders>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
})

describe("RightSidebar", () => {
  test("shows Research / TODOs / Files, with no Status and no Code changes by default", () => {
    renderSidebar()
    expect(screen.getByTestId("panel-tab-research")).toBeTruthy()
    expect(screen.getByTestId("panel-tab-todos")).toBeTruthy()
    expect(screen.getByTestId("panel-tab-files")).toBeTruthy()
    expect(screen.queryByTestId("panel-tab-status")).toBeNull()
    expect(screen.queryByTestId("panel-tab-changes")).toBeNull()
  })

  test("the gear opens a View-options menu whose toggle reveals and persists Code changes", () => {
    renderSidebar()
    expect(screen.queryByTestId("right-sidebar-settings-menu")).toBeNull()

    fireEvent.click(screen.getByTestId("right-sidebar-settings"))
    expect(screen.getByTestId("right-sidebar-settings-menu")).toBeTruthy()

    const toggle = screen.getByTestId("right-sidebar-toggle-changes")
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(toggle)

    expect(screen.getByTestId("panel-tab-changes")).toBeTruthy()
    expect(window.localStorage.getItem("skipper.projectView.showCodeChanges")).toBe("true")
  })

  test("the Files tab lists the tree and opening a file calls onOpenFile", async () => {
    const { onOpenFile } = renderSidebar()
    fireEvent.click(screen.getByTestId("panel-tab-files"))

    fireEvent.click(await screen.findByTestId("file-tree-file"))
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("main.py"))
  })

  test("excludes the Files tab when the left Files panel is enabled", () => {
    window.localStorage.setItem("skipper.projectView.showFilesPanel", "true")
    renderSidebar()

    expect(screen.queryByTestId("panel-tab-files")).toBeNull()
    expect(screen.getByTestId("panel-tab-research")).toBeTruthy()
    expect(screen.getByTestId("panel-tab-todos")).toBeTruthy()
    // The active-tab fallback stays valid — Research (the first tab) is selected.
    expect(screen.getByTestId("panel-tab-research").getAttribute("data-active")).toBe("true")
  })

  test("the collapse button sits next to the gear and calls onCollapse", () => {
    const { onCollapse } = renderSidebar()

    expect(screen.getByTestId("right-sidebar-settings")).toBeTruthy()
    fireEvent.click(screen.getByTestId("right-sidebar-collapse"))

    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  test("collapsing hides the sidebar and the expand affordance brings it back", () => {
    renderCollapsible()
    expect(screen.getByTestId("right-sidebar")).toBeTruthy()

    fireEvent.click(screen.getByTestId("right-sidebar-collapse"))
    expect(screen.queryByTestId("right-sidebar")).toBeNull()

    fireEvent.click(screen.getByTestId("right-sidebar-expand"))
    expect(screen.getByTestId("right-sidebar")).toBeTruthy()
  })
})
