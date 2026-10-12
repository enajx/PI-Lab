import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useEffect, useState } from "react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import {
  readProjectWorkspaceState,
  writeProjectWorkspaceState,
  writeProjectWorkspaceViewState,
} from "../../-workspaceState"
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

function renderSidebar(
  onOpenFile = vi.fn(),
  overrides: FakeHandlers = {},
  props: { gitAvailable?: boolean } = {},
) {
  const onCollapse = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "files.read": () => ({ status: "text", exists: true, content: "# Research\n" }),
    "files.tree": () => [{ name: "main.py", relPath: "main.py", kind: "file" as const }],
    "workspaces.changes": () => [],
    "science.skills.list": () => ({ skills: [], roots: [] }),
    ...overrides,
  })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <RightSidebar
        projectId="p1"
        workspaceId="ws-1"
        onOpenFile={onOpenFile}
        onCollapse={onCollapse}
        gitAvailable={props.gitAvailable}
      />
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
      projectId="p1"
      workspaceId="ws-1"
      onOpenFile={onOpenFile}
      onCollapse={() => setCollapsed(true)}
    />
  )
}

function renderCollapsible() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "files.read": () => ({ status: "text", exists: true, content: "# Research\n" }),
    "files.tree": () => [{ name: "main.py", relPath: "main.py", kind: "file" as const }],
    "workspaces.changes": () => [],
    "science.skills.list": () => ({ skills: [], roots: [] }),
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
    expect(screen.queryByTestId("panel-tab-skills")).toBeNull()
  })

  test("gives every project panel a concise purpose instead of its bare label", () => {
    renderSidebar()
    expect(screen.getByTestId("panel-tab-research").getAttribute("data-feature-help")).toBe(
      "Read the project's RESEARCH.md, where durable context and findings are kept.",
    )
    expect(screen.getByTestId("panel-tab-todos").getAttribute("data-feature-help")).toBe(
      "View the project's TODO.md, where project work items are tracked in Markdown.",
    )
    expect(screen.getByTestId("panel-tab-files").getAttribute("data-feature-help")).toBe(
      "Browse workspace files and open them in the built-in editor.",
    )

    fireEvent.click(screen.getByTestId("right-sidebar-settings"))
    fireEvent.click(screen.getByTestId("right-sidebar-toggle-changes"))
    expect(screen.getByTestId("panel-tab-changes").getAttribute("data-feature-help")).toBe(
      "Review staged, unstaged, and untracked Git changes in this workspace.",
    )
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
    expect(window.localStorage.getItem("pi-lab.projectView.showCodeChanges")).toBe("true")
  })

  test("disables Code changes with an Initialize Git explanation for a non-Git folder", () => {
    renderSidebar(vi.fn(), {}, { gitAvailable: false })

    fireEvent.click(screen.getByTestId("right-sidebar-settings"))
    const toggle = screen.getByTestId("right-sidebar-toggle-changes")
    expect(toggle.hasAttribute("disabled")).toBe(true)
    expect(toggle.getAttribute("data-feature-help")).toContain("Initialize Git")
    fireEvent.click(toggle)
    expect(screen.queryByTestId("panel-tab-changes")).toBeNull()
  })

  test("the gear independently reveals and persists the optional Skills panel", () => {
    renderSidebar()
    fireEvent.click(screen.getByTestId("right-sidebar-settings"))

    const toggle = screen.getByTestId("right-sidebar-toggle-skills")
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(toggle)

    expect(screen.getByTestId("panel-tab-skills")).toBeTruthy()
    expect(window.localStorage.getItem("pi-lab.projectView.showSkillsPanel")).toBe("true")
  })

  test("Skills panel shows project-local first and shares persisted scope filters", async () => {
    renderSidebar(vi.fn(), {
      "science.skills.list": () => ({
        skills: [
          {
            name: "local",
            description: "project skill",
            slug: "local",
            path: "/repo/.agents/skills/local/SKILL.md",
            source: ".agents/skills",
            harness: "agents",
            scope: "project",
          },
          {
            name: "global",
            description: "global skill",
            slug: "global",
            path: "/home/.codex/skills/global/SKILL.md",
            source: "~/.codex/skills",
            harness: "codex",
            scope: "global",
          },
        ],
        roots: [],
      }),
    })
    fireEvent.click(screen.getByTestId("right-sidebar-settings"))
    fireEvent.click(screen.getByTestId("right-sidebar-toggle-skills"))
    fireEvent.click(screen.getByTestId("panel-tab-skills"))

    await waitFor(() => expect(screen.getAllByTestId("skill-card")).toHaveLength(2))
    expect(screen.getAllByTestId("skill-name").map((node) => node.textContent)).toEqual([
      "local",
      "global",
    ])
    fireEvent.click(screen.getByTestId("panel-skills-show-global"))
    await waitFor(() => expect(screen.getAllByTestId("skill-card")).toHaveLength(1))
    expect(screen.getByTestId("skill-name").textContent).toBe("local")
    expect(window.localStorage.getItem("pi-lab.skills.showGlobal")).toBe("false")
  })

  test("Skills panel has a clear empty state", async () => {
    renderSidebar()
    fireEvent.click(screen.getByTestId("right-sidebar-settings"))
    fireEvent.click(screen.getByTestId("right-sidebar-toggle-skills"))
    fireEvent.click(screen.getByTestId("panel-tab-skills"))
    expect(await screen.findByTestId("panel-skills-empty")).toBeTruthy()
  })

  test("Skills panel surfaces a catalog query error", async () => {
    window.localStorage.setItem("pi-lab.projectView.showSkillsPanel", "true")
    renderSidebar(vi.fn(), {
      "science.skills.list": async () => {
        throw new Error("skills index failed")
      },
    })
    fireEvent.click(screen.getByTestId("panel-tab-skills"))
    expect((await screen.findByTestId("panel-skills-error")).textContent).toContain(
      "skills index failed",
    )
  })

  test("Skills panel re-indexes when the project id changes", async () => {
    window.localStorage.setItem("pi-lab.projectView.showSkillsPanel", "true")
    const requested: string[] = []
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const client = createFakeTrpcClient({
      "files.read": () => ({ status: "text", exists: true, content: "# Research\n" }),
      "files.tree": () => [],
      "workspaces.changes": () => [],
      "science.skills.list": (input) => {
        const projectId = (input as { projectId: string }).projectId
        requested.push(projectId)
        return {
          skills: [
            {
              name: `${projectId}-skill`,
              description: "",
              slug: `${projectId}-skill`,
              path: `/repo/${projectId}/.agents/skills/${projectId}-skill/SKILL.md`,
              source: ".agents/skills",
              harness: "agents",
              scope: "project",
            },
          ],
          roots: [],
        }
      },
    })
    const sidebar = (projectId: string) => (
      <AppProviders client={client} queryClient={queryClient}>
        <RightSidebar
          projectId={projectId}
          workspaceId={`ws-${projectId}`}
          onOpenFile={() => {}}
          onCollapse={() => {}}
        />
      </AppProviders>
    )
    const view = render(sidebar("p1"))
    fireEvent.click(screen.getByTestId("panel-tab-skills"))
    await screen.findByText("p1-skill")

    view.rerender(sidebar("p2"))
    await screen.findByText("p2-skill")
    expect(requested).toEqual(["p1", "p2"])
    expect(screen.queryByText("p1-skill")).toBeNull()
  })

  test("the Files tab lists the tree and opening a file calls onOpenFile", async () => {
    const { onOpenFile } = renderSidebar()
    fireEvent.click(screen.getByTestId("panel-tab-files"))

    fireEvent.click(await screen.findByTestId("file-tree-file"))
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("main.py"))
  })

  test("excludes the Files tab when the left Files panel is enabled", () => {
    window.localStorage.setItem("pi-lab.projectView.showFilesPanel", "true")
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

/**
 * Feature F?? — pin arbitrary `.md` files as persistent per-project right-sidebar
 * panels. `PinnedHarness` mirrors how the project route (`$projectId.tsx`) owns the
 * pinned list: it seeds/reads it from `-workspaceState`, persists on change via
 * `writeProjectWorkspaceViewState`, and threads pin/unpin handlers into the sidebar —
 * so these tests drive the real persistence path and the sidebar's real controls.
 */
function seedWorkspaceState(projectId: string) {
  // The view-state writer only updates an existing entry, so seed one first (the
  // central panel does this in production before the view effect runs).
  writeProjectWorkspaceState(projectId, {
    buffers: [],
    activeRelPath: null,
    sessions: [],
    active: null,
    belowEditorRun: null,
  })
}

function PinnedHarness({ projectId }: { projectId: string }) {
  const [restored] = useState(() => readProjectWorkspaceState(projectId, true))
  const [pinned, setPinned] = useState<string[]>(() => restored?.pinnedPanels ?? [])
  const [activeId, setActiveId] = useState<string | null>(
    () => restored?.rightSidebarActiveId ?? null,
  )
  useEffect(() => {
    writeProjectWorkspaceViewState(projectId, {
      rightSidebarCollapsed: false,
      rightSidebarActiveId: activeId,
      pinnedPanels: pinned,
    })
  }, [projectId, pinned, activeId])
  return (
    <RightSidebar
      projectId={projectId}
      workspaceId="ws-1"
      onOpenFile={vi.fn()}
      onCollapse={vi.fn()}
      initialActiveId={activeId ?? undefined}
      onActiveIdChange={setActiveId}
      pinnedPanels={pinned}
      onPinFile={(relPath) =>
        setPinned((prev) => (prev.includes(relPath) ? prev : [...prev, relPath]))
      }
      onUnpinFile={(relPath) => setPinned((prev) => prev.filter((path) => path !== relPath))}
    />
  )
}

function renderPinned(projectId: string, overrides: FakeHandlers = {}) {
  seedWorkspaceState(projectId)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "files.read": () => ({ status: "text", exists: true, content: "# Pinned notes\n" }),
    "files.tree": () => [{ name: "notes.md", relPath: "notes.md", kind: "file" as const }],
    "files.search": () => ({
      hits: [{ relPath: "notes.md" }, { relPath: "main.py" }],
      partial: false,
      skipped: [],
    }),
    "workspaces.changes": () => [],
    "science.skills.list": () => ({ skills: [], roots: [] }),
    ...overrides,
  })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <PinnedHarness projectId={projectId} />
    </AppProviders>,
  )
}

describe("RightSidebar pinned Markdown panels", () => {
  test("right-clicking a .md file in the tree offers Pin as panel, which adds a panel", async () => {
    renderPinned("p-tree")
    fireEvent.click(screen.getByTestId("panel-tab-files"))

    const fileRow = await screen.findByTestId("file-tree-file")
    expect(fileRow.getAttribute("data-rel-path")).toBe("notes.md")
    fireEvent.contextMenu(fileRow)

    fireEvent.click(screen.getByTestId("file-tree-pin"))

    const pinnedTab = await screen.findByTestId("panel-tab-pinned:notes.md")
    fireEvent.click(pinnedTab)
    expect(await screen.findByTestId("panel-pinned:notes.md")).toBeTruthy()
    expect(await screen.findByText("Pinned notes")).toBeTruthy()
  })

  test("the + control pins a selected .md file (and filters out non-.md hits)", async () => {
    renderPinned("p-plus")
    fireEvent.click(screen.getByTestId("right-sidebar-pin"))

    fireEvent.change(screen.getByTestId("quick-open-input"), { target: { value: "notes" } })
    const results = await screen.findAllByTestId("quick-open-result")
    // main.py is filtered out; only the .md hit is selectable.
    expect(results.map((node) => node.getAttribute("data-rel-path"))).toEqual(["notes.md"])

    fireEvent.click(screen.getByTestId("quick-open-result"))
    expect(await screen.findByTestId("panel-tab-pinned:notes.md")).toBeTruthy()
    expect(screen.queryByTestId("quick-open")).toBeNull()
  })

  test("pinned panels persist to -workspaceState and restore on a fresh mount", async () => {
    const view = renderPinned("p-persist")
    fireEvent.click(screen.getByTestId("right-sidebar-pin"))
    fireEvent.change(screen.getByTestId("quick-open-input"), { target: { value: "notes" } })
    fireEvent.click(await screen.findByTestId("quick-open-result"))
    await screen.findByTestId("panel-tab-pinned:notes.md")

    // Persisted through the real workspace-state writer.
    expect(readProjectWorkspaceState("p-persist", true)?.pinnedPanels).toEqual(["notes.md"])

    // A fresh mount (app relaunch) restores the pinned panel from that state.
    view.unmount()
    renderPinned("p-persist")
    expect(await screen.findByTestId("panel-tab-pinned:notes.md")).toBeTruthy()
  })

  test("unpinning removes the panel and the active tab falls back to the first tab", async () => {
    seedWorkspaceState("p-unpin")
    writeProjectWorkspaceViewState("p-unpin", {
      rightSidebarCollapsed: false,
      rightSidebarActiveId: "pinned:notes.md",
      pinnedPanels: ["notes.md"],
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const client = createFakeTrpcClient({
      "files.read": () => ({ status: "text", exists: true, content: "# Pinned notes\n" }),
      "files.tree": () => [],
      "files.search": () => ({ hits: [], partial: false, skipped: [] }),
      "workspaces.changes": () => [],
      "science.skills.list": () => ({ skills: [], roots: [] }),
    })
    render(
      <AppProviders client={client} queryClient={queryClient}>
        <PinnedHarness projectId="p-unpin" />
      </AppProviders>,
    )

    expect(screen.getByTestId("panel-tab-pinned:notes.md")).toBeTruthy()
    fireEvent.click(screen.getByTestId("right-sidebar-unpin:notes.md"))

    await waitFor(() => expect(screen.queryByTestId("panel-tab-pinned:notes.md")).toBeNull())
    // The active-tab fallback still resolves — Research (the first tab) is shown.
    expect(await screen.findByTestId("panel-research")).toBeTruthy()
    expect(readProjectWorkspaceState("p-unpin", true)?.pinnedPanels).toEqual([])
  })
})
