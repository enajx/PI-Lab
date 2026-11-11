import { QueryClient } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { PropsWithChildren } from "react"
import { expect, test, vi } from "vitest"
import { AppProviders } from "../providers/AppProviders"
import { createFakeTrpcClient } from "../test/fakeTrpcClient"
import { useDefaultAgentId, useHeaderShortcuts } from "./preferences"

test("legacy agent preference migrates once and configured changes reach mounted consumers", async () => {
  window.localStorage.setItem("pi-lab.defaultAgentId", "codex")
  let agents = { defaultAgentId: null as string | null }
  const update = vi.fn((input: unknown) => {
    agents = { ...agents, ...(input as typeof agents) }
    return agents
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "settings.get": () => ({ agents }),
    "settings.updateAgents": update,
    "settings.initializeDefaultAgent": (input) => {
      if (agents.defaultAgentId === null)
        agents.defaultAgentId = (input as { agentId: string }).agentId
      return agents
    },
  })
  const wrapper = ({ children }: PropsWithChildren) => (
    <AppProviders client={client} queryClient={queryClient}>
      {children}
    </AppProviders>
  )
  const first = renderHook(() => useDefaultAgentId(), { wrapper })
  await waitFor(() => expect(agents.defaultAgentId).toBe("codex"))
  const second = renderHook(() => useDefaultAgentId(), { wrapper })
  await act(async () => {
    await first.result.current[1]("claude-code")
  })
  await waitFor(() => expect(second.result.current[0]).toBe("claude-code"))
  expect(window.localStorage.getItem("pi-lab.defaultAgentId")).toBe("claude-code")
  const writes = update.mock.calls.length
  second.unmount()
  const reopened = renderHook(() => useDefaultAgentId(), { wrapper })
  await waitFor(() => expect(reopened.result.current[0]).toBe("claude-code"))
  expect(update).toHaveBeenCalledTimes(writes)
  first.unmount()
  reopened.unmount()
  queryClient.clear()
  window.localStorage.removeItem("pi-lab.defaultAgentId")
})

test("saved header shortcut lists get each later built-in once, and keep earlier removals", () => {
  // Project view list from version 1: Paper is added after Tasks, Research diary at the end.
  window.localStorage.setItem(
    "pi-lab.projectView.headerShortcuts",
    JSON.stringify(["tasks", "project-status"]),
  )
  // LaTeX list saved at version 2 with Sync removed: Sync must not come back.
  window.localStorage.setItem(
    "pi-lab.latexEditor.headerShortcuts",
    JSON.stringify(["update-paper"]),
  )
  window.localStorage.setItem("pi-lab.latexEditor.headerShortcutsVersion", "2")
  const project = renderHook(() => useHeaderShortcuts("project"))
  const latex = renderHook(() => useHeaderShortcuts("latex"))
  expect(project.result.current[0]).toEqual(["tasks", "paper", "project-status", "research-diary"])
  expect(latex.result.current[0]).toEqual(["update-paper"])
  project.unmount()
  latex.unmount()
  window.localStorage.clear()
})
