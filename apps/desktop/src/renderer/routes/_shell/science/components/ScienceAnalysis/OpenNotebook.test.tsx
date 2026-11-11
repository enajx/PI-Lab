import type { Project } from "@pi-lab/local-db"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"

// The router is a fake (mocked); these tests never navigate.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }))
// xterm needs layout APIs jsdom lacks.
vi.mock("../../../../../Terminal", () => ({ Terminal: () => <div data-testid="terminal" /> }))

const { ScienceAnalysis } = await import("./ScienceAnalysis")

/**
 * Component test (fake tRPC client, no main process) for Open notebook in Analysis:
 * the button opens a notebook tab in the session panel, the tab offers Open in
 * browser and, for a PI Lab copy in a uv project, Add Jupyter to this project.
 * Closing the tab stops its server.
 */

const PROJECT: Project = {
  id: "p1",
  name: "alpha",
  repoPath: "/repos/alpha",
  defaultBranch: "main",
  color: null,
  thumbnail: null,
  gradient: null,
  digitalRain: false,
  metadata: null,
  taskRelPath: null,
  mainRelPath: null,
  typeId: "general",
  agentConfig: null,
  sortIndex: 0,
  sortOrder: null,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  lastOpenedAt: 0,
}

const NOTEBOOK_FILE = {
  relPath: "results/run/analysis.ipynb",
  name: "analysis.ipynb",
  kind: "notebook",
  experiment: "run",
  inReportsFolder: false,
  size: 10,
  mtime: 0,
}

function handlers(extra: FakeHandlers): FakeHandlers {
  return {
    "projects.list": () => [PROJECT],
    "projects.capabilities": () => ({ git: true }),
    "science.analysis.listFiles": () => ({
      groups: [{ kind: "notebook", files: [NOTEBOOK_FILE] }],
      total: 1,
      truncated: false,
      partial: false,
      skipped: [],
      resultsFolder: "results",
      overridden: false,
      exists: true,
    }),
    "science.analysis.preview": () => ({ type: "notebook", cells: [] }),
    "workspaces.ensureMain": () => ({ id: "ws-1" }),
    "settings.get": () => ({ agents: { defaultAgentId: "claude-code" } }),
    "agents.list": () => [],
    "agents.projectChoice": () => ({ agentId: null, storage: "app" }),
    "terminal.list": () => [],
    "files.tree": () => [],
    ...extra,
  }
}

function renderAnalysis(fake: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={createFakeTrpcClient(fake)} queryClient={queryClient}>
      <ScienceAnalysis focusSession={null} />
    </AppProviders>,
  )
}

describe("Open notebook in Analysis", () => {
  beforeEach(() => window.localStorage.clear())

  test("opens a Jupyter tab with Open in browser and Add Jupyter to this project, and closing it stops the server", async () => {
    const start = vi.fn((_input: unknown) => ({
      url: "http://127.0.0.1:42700/lab/tree/results/run/analysis.ipynb?token=t",
      tool: "jupyter",
      environmentLabel: "PI Lab copy (uvx)",
      canAddToProject: true,
    }))
    const stop = vi.fn((_input: unknown) => undefined)
    const openInBrowser = vi.fn((_input: unknown) => undefined)
    const addToProject = vi.fn((_input: unknown) => ({
      ok: true,
      output: "$ uv add --dev jupyterlab ipykernel\nResolved 90 packages",
    }))
    renderAnalysis(
      handlers({
        "notebooks.start": start,
        "notebooks.stop": stop,
        "notebooks.openInBrowser": openInBrowser,
        "notebooks.addToProject": addToProject,
      }),
    )
    fireEvent.click(await screen.findByTestId("analysis-file"))
    fireEvent.click(await screen.findByTestId("analysis-open-notebook"))

    const frame = await screen.findByTestId("notebook-frame")
    expect(frame.getAttribute("src")).toBe(
      "http://127.0.0.1:42700/lab/tree/results/run/analysis.ipynb?token=t",
    )
    const serverId = (start.mock.calls[0]?.[0] as { serverId: string }).serverId
    expect(start.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      relPath: "results/run/analysis.ipynb",
      serverId,
    })
    expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("false")
    const tab = screen.getByTestId("central-tab")
    expect(tab.textContent).toContain("analysis.ipynb")
    expect(screen.getByTestId("notebook-environment").textContent).toContain("PI Lab copy (uvx)")

    fireEvent.click(screen.getByTestId("notebook-open-browser"))
    await waitFor(() => expect(openInBrowser).toHaveBeenCalledWith({ serverId }))

    fireEvent.click(screen.getByTestId("notebook-add-to-project"))
    expect(screen.getByTestId("notebook-add-to-project").textContent).toBe(
      "Add Jupyter to this project",
    )
    await waitFor(() =>
      expect(addToProject).toHaveBeenCalledWith({ workspaceId: "ws-1", tool: "jupyter" }),
    )
    expect((await screen.findByTestId("notebook-add-output")).textContent).toContain(
      "Resolved 90 packages",
    )

    fireEvent.click(within(tab).getByTestId("central-tab-close"))
    await waitFor(() => expect(stop).toHaveBeenCalledWith({ serverId }))
    expect(screen.queryByTestId("notebook-frame")).toBeNull()
  })

  test("a notebook server that cannot start shows why in its tab", async () => {
    renderAnalysis(
      handlers({
        "notebooks.start": () => {
          throw new Error(
            "Jupyter is not installed in this project's environment, and uv was not found",
          )
        },
        "notebooks.stop": () => undefined,
      }),
    )
    fireEvent.click(await screen.findByTestId("analysis-file"))
    fireEvent.click(await screen.findByTestId("analysis-open-notebook"))
    expect((await screen.findByTestId("notebook-error")).textContent).toContain("uv was not found")
  })
})
