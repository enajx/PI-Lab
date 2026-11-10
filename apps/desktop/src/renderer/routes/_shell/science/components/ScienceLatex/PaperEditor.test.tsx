import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { QueryClient } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"

/**
 * Component tests for the LaTeX Editor workspace: its agent tabs and their
 * restore. The tRPC server is a fake (mocked), so these check the renderer flow
 * only; the e2e test covers the real app. xterm and CodeMirror need layout APIs
 * jsdom lacks, so both are stubbed.
 */
vi.mock("../../../../../Terminal", () => ({
  Terminal: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid="terminal" data-session-id={sessionId} />
  ),
}))

vi.mock("../../../../../Editor/components/CodeMirrorBuffer", () => ({
  CodeMirrorBuffer: ({ relPath }: { relPath: string }) => (
    <div data-testid="editor-buffer">{relPath}</div>
  ),
}))

const { PaperEditor } = await import("./PaperEditor")

let started: unknown[]
let liveSessionIds: string[]
let startWarning: string | null

beforeEach(() => {
  started = []
  liveSessionIds = []
  startWarning = null
})

function handlers(): FakeHandlers {
  return {
    "paper.outline": () => [],
    "files.tree": () => [{ name: "main.tex", relPath: "main.tex", kind: "file" as const }],
    "files.read": () => ({
      status: "text",
      exists: true,
      content: "\\documentclass{article}\n",
      baseline: { exists: true, mtimeMs: 1, size: 24 },
    }),
    "files.stat": () => ({ exists: false, mtimeMs: 0, size: 0 }),
    "settings.get": () => ({ agents: { defaultAgentId: "claude-code" } }),
    "agents.list": () => [
      { id: "claude-code", label: "Claude Code", available: true, executable: "/bin/claude" },
    ],
    "agents.projectChoice": () => ({ agentId: null, storage: "app" }),
    "sessions.start": (input) => {
      started.push(input)
      const sessionId = `agent-${started.length}`
      liveSessionIds.push(sessionId)
      return { sessionId, workspaceId: "paper-ws", kind: "branch", warning: startWarning }
    },
    "terminal.list": () => liveSessionIds.map((id) => ({ id, alive: true })),
    "terminal.kill": () => ({ ok: true }),
    "latex.status": () => ({
      provider: "auto",
      bundled: { available: true, version: "Tectonic 0.15.0", name: "Tectonic", error: null },
      system: { available: false, version: null, name: "System LaTeX", error: "Not found" },
      engine: { kind: "bundled", name: "Tectonic" },
      installation: { state: "idle", progress: null, message: "", error: null },
    }),
    "paper.startUpdate": (input) => {
      started.push(input)
      const sessionId = `update-${started.length}`
      liveSessionIds.push(sessionId)
      return {
        sessionId,
        workspaceId: "paper-ws",
        kind: "branch",
        warning: null,
        agentId: "claude-code",
      }
    },
  }
}

/** Mount the LaTeX Editor workspace for a project as the page does. */
function renderEditor(
  client: ReturnType<typeof createFakeTrpcClient>,
  projectId: string,
  focusSession: { sessionId: string; agentId: string; agentLabel: string } | null,
  buildOnOpen: boolean,
  syncSlot: HTMLElement | null,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <PaperEditor
        buildOnOpen={buildOnOpen}
        projectId={projectId}
        projectName="Project"
        workspaceId="paper-ws"
        paperDir="/proj/paper"
        displayDir="paper"
        rootRelPath="main.tex"
        lastSyncAt={null}
        hasRemote={false}
        syncEnabled={true}
        outputDir={null}
        effectiveOutputDir="build"
        settings={DEFAULT_EDITOR_SETTINGS}
        onUpdateEditorSettings={() => undefined}
        focusSession={focusSession}
        syncSlot={syncSlot}
      />
    </AppProviders>,
  )
}

function tabLabels(): string[] {
  return screen
    .getAllByTestId("central-tab")
    .map((tab) => within(tab).getByTestId("central-tab-select").getAttribute("aria-label") ?? "")
}

describe("PaperEditor agents (mocked server)", () => {
  test("starts agents as LaTeX Editor agents and keeps its tabs after leaving and coming back", async () => {
    const client = createFakeTrpcClient(handlers())
    renderEditor(client, "p1", null, false, null)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex"]))
    await waitFor(() =>
      expect(screen.getByTestId("central-new-agent").hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByTestId("central-new-agent"))
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex", "Claude Code"]))
    expect(started).toEqual([expect.objectContaining({ projectId: "p1", origin: "latex" })])

    // Leave the page (unmount) and come back.
    cleanup()
    renderEditor(client, "p1", null, false, null)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex", "Claude Code"]))
    const agentTab = screen
      .getAllByTestId("central-tab")
      .find((tab) => tab.getAttribute("data-tab-kind") === "agent")
    expect(agentTab?.getAttribute("data-active")).toBe("true")
    expect(started).toHaveLength(1)
    cleanup()
  })

  test("a requested agent session is focused, and attached as a tab when it is not open yet", async () => {
    liveSessionIds = ["live-latex-agent"]
    const client = createFakeTrpcClient(handlers())
    renderEditor(
      client,
      "p2",
      {
        sessionId: "live-latex-agent",
        agentId: "claude-code",
        agentLabel: "Claude Code",
      },
      false,
      null,
    )
    await waitFor(() => expect(tabLabels()).toContain("Claude Code"))
    const agentTab = screen
      .getAllByTestId("central-tab")
      .find((tab) => tab.getAttribute("data-tab-kind") === "agent")
    expect(agentTab?.getAttribute("data-active")).toBe("true")
    expect(screen.getByTestId("terminal").getAttribute("data-session-id")).toBe("live-latex-agent")
    expect(started).toEqual([])
    cleanup()
  })

  test("a start warning (agent cannot be given the paper folder) is shown near the tabs", async () => {
    startWarning =
      "Claude Code cannot be given the paper folder /papers/p; it only sees the project folder."
    const client = createFakeTrpcClient(handlers())
    renderEditor(client, "p3", null, false, null)
    await waitFor(() =>
      expect(screen.getByTestId("central-new-agent").hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByTestId("central-new-agent"))
    expect((await screen.findByTestId("central-launch-warning")).textContent).toContain(
      startWarning,
    )
    cleanup()
  })
})

describe("PaperEditor left column (mocked server)", () => {
  test("the column starts hidden; once opened, Files and Outline are both expanded, Outline below Files", async () => {
    for (const key of ["leftColumn", "filesOpen", "outlineOpen"]) {
      window.localStorage.removeItem(`pi-lab.latexEditor.${key}`)
    }
    const client = createFakeTrpcClient(handlers())
    renderEditor(client, "p4", null, false, null)
    const toggle = await screen.findByTestId("central-files-toggle")
    expect(screen.queryByTestId("central-files-panel")).toBeNull()
    fireEvent.click(toggle)
    const column = await screen.findByTestId("central-files-panel")
    const files = within(column).getByTestId("central-files-section")
    const outline = within(column).getByTestId("paper-outline-section")
    expect(files.getAttribute("aria-expanded")).toBe("true")
    expect(outline.getAttribute("aria-expanded")).toBe("true")
    // Files comes first in the column, Outline after it.
    expect(files.compareDocumentPosition(outline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // A saved collapsed state still applies.
    fireEvent.click(files)
    await waitFor(() => expect(within(column).queryByTestId("panel-files")).toBeNull())
    expect(window.localStorage.getItem("pi-lab.latexEditor.filesOpen")).toContain("false")
    cleanup()
  })
})

describe("PaperEditor Create paper and Update paper (mocked server)", () => {
  test("a just-created paper builds main.tex and opens its PDF beside the source", async () => {
    const builds: unknown[] = []
    const client = createFakeTrpcClient({
      ...handlers(),
      // The PDF exists only once the build has run.
      "files.stat": (input) => ({
        exists: builds.length > 0 && (input as { relPath: string }).relPath === "build/main.pdf",
        mtimeMs: 1,
        size: 10,
      }),
      "pdf.build": (input) => {
        builds.push(input)
        return { relPath: "build/main.pdf", success: true, log: "" }
      },
    })
    renderEditor(client, "p5", null, true, null)
    await waitFor(() => expect(builds).toEqual([{ workspaceId: "paper-ws", relPath: "main.tex" }]))
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex", "main.pdf"]))
    cleanup()
  })

  test("an existing paper with no PDF is not built when it opens", async () => {
    const builds: unknown[] = []
    const client = createFakeTrpcClient({
      ...handlers(),
      "pdf.build": (input) => {
        builds.push(input)
        return { relPath: "build/main.pdf", success: true, log: "" }
      },
    })
    renderEditor(client, "p6", null, false, null)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex"]))
    expect(builds).toEqual([])
    cleanup()
  })

  test("Update paper in the top bar starts a write-research agent as a focused tab", async () => {
    const slot = document.createElement("div")
    document.body.append(slot)
    const client = createFakeTrpcClient(handlers())
    renderEditor(client, "p7", null, false, slot)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex"]))
    const button = within(slot).getByTestId("paper-update")
    // It sits before Sync in the top bar.
    const sync = within(slot).getByTestId("paper-sync")
    expect(button.compareDocumentPosition(sync) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(button)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex", "Update paper"]))
    expect(started).toEqual([{ projectId: "p7" }])
    const agentTab = screen
      .getAllByTestId("central-tab")
      .find((tab) => tab.getAttribute("data-tab-kind") === "agent")
    expect(agentTab?.getAttribute("data-active")).toBe("true")
    cleanup()
    slot.remove()
  })
})
