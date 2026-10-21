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
function setup(initialState: CentralPanelRestoreState, handlers: FakeHandlers) {
  const client = createFakeTrpcClient({
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
  )
  await waitFor(() => expect(run).toHaveBeenCalledOnce())
  act(() => view.result.current.closeBelowEditorRun())
  await act(async () => restored.resolve({ sessionId: "orphan-run" }))
  await waitFor(() => expect(kill).toHaveBeenCalledWith({ sessionId: "orphan-run" }))
  expect(view.result.current.belowEditorRun).toBeNull()
  view.dispose()
})
