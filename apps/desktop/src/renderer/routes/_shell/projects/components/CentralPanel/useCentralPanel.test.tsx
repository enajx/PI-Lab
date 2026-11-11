import { QueryClient } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { expect, test, vi } from "vitest"
import { DEFAULT_EDITOR_SETTINGS } from "../../../../../Editor/hooks/useEditorBuffers"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { type CentralPanelRestoreState, useCentralPanel } from "./useCentralPanel"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Async restoration races use an injected IPC boundary and the shipping controller. */
function setup(
  initialState: CentralPanelRestoreState | undefined,
  handlers: FakeHandlers,
  origin: "project" | "latex",
) {
  const client = createFakeTrpcClient({
    "settings.get": () => ({ agents: { defaultAgentId: "claude-code" } }),
    "agents.list": () => [],
    "agents.projectChoice": () => ({ agentId: null }),
    "terminal.list": () => [],
    ...handlers,
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const hook = renderHook(
    () =>
      useCentralPanel({
        client,
        workspaceId: "restore-race",
        projectId: "restore-project",
        origin,
        settings: DEFAULT_EDITOR_SETTINGS,
        initialState,
      }),
    { wrapper: ({ children }) => createElement(AppProviders, { client, queryClient, children }) },
  )
  return {
    ...hook,
    dispose: () => {
      hook.unmount()
      queryClient.clear()
    },
  }
}

test("restoration preserves newly opened panes and reaps a recreated pane closed while pending", async () => {
  const restored = deferred<{ sessionId: string }>()
  const spawn = vi
    .fn()
    .mockReturnValueOnce(restored.promise)
    .mockResolvedValueOnce({ sessionId: "new-terminal" })
  const kill = vi.fn(() => ({ ok: true }))
  const view = setup(
    {
      buffers: [],
      activeRelPath: null,
      belowEditorRun: null,
      sessions: [
        {
          id: "pane-1",
          kind: "terminal",
          sessionId: "old-terminal",
          label: "Old",
          launch: { type: "terminal" },
        },
      ],
      active: { type: "session", id: "pane-1" },
    },
    { "workspaces.spawnTerminal": spawn, "terminal.kill": kill },
    "project",
  )
  await waitFor(() => expect(spawn).toHaveBeenCalledOnce())
  act(() => view.result.current.openTerminal())
  await waitFor(() => expect(view.result.current.sessions).toHaveLength(2))
  act(() => view.result.current.closeSession("pane-1"))
  await act(async () => restored.resolve({ sessionId: "restored-orphan" }))
  await waitFor(() => expect(kill).toHaveBeenCalledWith({ sessionId: "restored-orphan" }))
  expect(view.result.current.sessions.map((pane) => pane.sessionId)).toEqual(["new-terminal"])
  expect(view.result.current.active).toEqual({ type: "session", id: "pane-2" })
  view.dispose()
})

test("closing a below-editor run during restore does not resurrect its replacement PTY", async () => {
  const restored = deferred<{ sessionId: string }>()
  const run = vi.fn(() => restored.promise)
  const kill = vi.fn(() => ({ ok: true }))
  const view = setup(
    {
      buffers: [],
      activeRelPath: null,
      sessions: [],
      active: null,
      belowEditorRun: { sessionId: "old-run", label: "Run file.py", relPath: "file.py" },
    },
    { "python.runFile": run, "terminal.kill": kill },
    "project",
  )
  await waitFor(() => expect(run).toHaveBeenCalledOnce())
  act(() => view.result.current.closeBelowEditorRun())
  await act(async () => restored.resolve({ sessionId: "orphan-run" }))
  await waitFor(() => expect(kill).toHaveBeenCalledWith({ sessionId: "orphan-run" }))
  expect(view.result.current.belowEditorRun).toBeNull()
  view.dispose()
})

test("agents launched and restored by a panel record the panel's view as their origin", async () => {
  const start = vi
    .fn()
    .mockResolvedValueOnce({ sessionId: "restored-agent", workspaceId: "w", kind: "branch" })
    .mockResolvedValueOnce({ sessionId: "new-agent", workspaceId: "w", kind: "branch" })
  const view = setup(
    {
      buffers: [],
      activeRelPath: null,
      belowEditorRun: null,
      sessions: [
        {
          id: "pane-1",
          kind: "agent",
          sessionId: "gone-agent",
          label: "Claude Code",
          launch: { type: "agent", agentId: "claude-code", workspaceMode: "policy" },
        },
      ],
      active: { type: "session", id: "pane-1" },
    },
    { "sessions.start": start },
    "latex",
  )
  await waitFor(() => expect(start).toHaveBeenCalledOnce())
  expect(start.mock.calls[0]?.[0]).toMatchObject({ agentId: "claude-code", origin: "latex" })
  act(() => view.result.current.launchChosenAgent("codex", "main"))
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
  expect(start.mock.calls[1]?.[0]).toMatchObject({ agentId: "codex", origin: "latex" })
  view.dispose()
})
