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
  }
}

/** Mount the LaTeX Editor workspace for a project as the page does. */
function renderEditor(
  client: ReturnType<typeof createFakeTrpcClient>,
  projectId: string,
  focusSession: { sessionId: string; agentId: string; agentLabel: string } | null,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <PaperEditor
        projectId={projectId}
        projectName="Project"
        workspaceId="paper-ws"
        rootRelPath="main.tex"
        lastSyncAt={null}
        hasRemote={false}
        outputDir={null}
        effectiveOutputDir="build"
        settings={DEFAULT_EDITOR_SETTINGS}
        onUpdateEditorSettings={() => undefined}
        focusSession={focusSession}
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
    renderEditor(client, "p1", null)
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex"]))
    await waitFor(() =>
      expect(screen.getByTestId("central-new-agent").hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByTestId("central-new-agent"))
    await waitFor(() => expect(tabLabels()).toEqual(["main.tex", "Claude Code"]))
    expect(started).toEqual([expect.objectContaining({ projectId: "p1", origin: "latex" })])

    // Leave the page (unmount) and come back.
    cleanup()
    renderEditor(client, "p1", null)
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
    renderEditor(client, "p2", {
      sessionId: "live-latex-agent",
      agentId: "claude-code",
      agentLabel: "Claude Code",
    })
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
    renderEditor(client, "p3", null)
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
