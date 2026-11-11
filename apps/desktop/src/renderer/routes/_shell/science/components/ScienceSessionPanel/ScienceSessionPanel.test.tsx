import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"

/**
 * The Tasks and Analysis session panel, driven through its public component with a
 * faked tRPC client (mocked: no main process). xterm needs layout APIs jsdom lacks, so
 * the terminal is a stub that shows its session id.
 */
vi.mock("../../../../../Terminal", () => ({
  Terminal: ({ inputKind, sessionId }: { inputKind: "agent" | "terminal"; sessionId?: string }) => (
    <div data-testid="terminal" data-input-kind={inputKind} data-session-id={sessionId} />
  ),
}))

const { ScienceSessionPanel } = await import("./ScienceSessionPanel")

let ensured: string[]
let started: Array<{ agentId: string; origin: string; projectId: string }>

beforeEach(() => {
  window.localStorage.clear()
  ensured = []
  started = []
})

function handlers(): FakeHandlers {
  return {
    "workspaces.ensureMain": (input) => {
      ensured.push((input as { projectId: string }).projectId)
      return { id: "ws-1" }
    },
    "settings.get": () => ({ agents: { defaultAgentId: "claude-code" } }),
    "settings.updateEditor": () => ({}),
    "agents.list": () => [
      { id: "claude-code", label: "Claude Code", available: true, executable: "/usr/bin/claude" },
    ],
    "agents.projectChoice": () => ({ agentId: null, storage: "app" }),
    "sessions.start": (input) => {
      started.push(input as { agentId: string; origin: string; projectId: string })
      return { sessionId: `agent-${started.length}`, workspaceId: "ws-1", kind: "branch" }
    },
    "workspaces.spawnTerminal": () => ({ sessionId: "term-1" }),
    "terminal.list": () => [],
    "terminal.kill": () => ({ ok: true }),
    "files.tree": () => [],
  }
}

function renderPanel(
  view: "tasks" | "analysis",
  project: { id: string; name: string } | null,
  fake: FakeHandlers,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(fake)
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <ScienceSessionPanel
        view={view}
        project={project}
        openSession={null}
        onSessionOpened={() => undefined}
      />
    </AppProviders>,
  )
}

/** Wait until the agent button can act, so ⌘T is not ignored as "pending". */
async function agentReady(): Promise<void> {
  fireEvent.click(await screen.findByTestId("science-sessions-expand"))
  await waitFor(() =>
    expect(screen.getByTestId("central-new-agent").hasAttribute("disabled")).toBe(false),
  )
  fireEvent.click(screen.getByTestId("science-sessions-collapse"))
}

describe("ScienceSessionPanel", () => {
  test("starts collapsed, and ⌘T opens an agent in the project and shows the panel", async () => {
    renderPanel("analysis", { id: "p-1", name: "Project 1" }, handlers())
    await agentReady()
    expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("true")

    fireEvent.keyDown(window, { key: "t", metaKey: true })

    await screen.findByTestId("terminal")
    expect(started).toEqual([
      expect.objectContaining({ agentId: "claude-code", origin: "analysis", projectId: "p-1" }),
    ])
    expect(ensured).toContain("p-1")
    expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("false")
  })

  test("keeps its tabs when the view is left and opened again", async () => {
    const first = renderPanel("tasks", { id: "p-1", name: "Project 1" }, handlers())
    await agentReady()
    fireEvent.keyDown(window, { key: "t", metaKey: true })
    await screen.findByTestId("terminal")
    expect(started[0]?.origin).toBe("tasks")
    first.unmount()

    // The agent's PTY is still alive, so the restored tab reattaches to it.
    renderPanel(
      "tasks",
      { id: "p-1", name: "Project 1" },
      {
        ...handlers(),
        "terminal.list": () => [{ id: "agent-1", alive: true }],
      },
    )

    const terminal = await screen.findByTestId("terminal")
    expect(terminal.getAttribute("data-session-id")).toBe("agent-1")
    expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("false")
  })

  test("with no project, ⌘T and the panel buttons ask to pick a project", async () => {
    renderPanel("tasks", null, handlers())

    act(() => {
      fireEvent.keyDown(window, { key: "t", metaKey: true })
    })
    expect((await screen.findByTestId("science-sessions-notice")).textContent).toBe(
      "Pick a project to open a session",
    )
    expect(screen.getByTestId("science-sessions").getAttribute("data-collapsed")).toBe("false")

    fireEvent.click(screen.getByTestId("science-sessions-dismiss-notice"))
    expect(screen.queryByTestId("science-sessions-notice")).toBeNull()
    fireEvent.click(screen.getByTestId("science-sessions-new-terminal"))
    expect(screen.getByTestId("science-sessions-notice")).toBeTruthy()
    expect(ensured).toEqual([])
    expect(started).toEqual([])
  })
})
