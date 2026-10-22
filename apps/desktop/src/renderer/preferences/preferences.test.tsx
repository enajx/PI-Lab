import { QueryClient } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { PropsWithChildren } from "react"
import { expect, test, vi } from "vitest"
import { AppProviders } from "../providers/AppProviders"
import { createFakeTrpcClient } from "../test/fakeTrpcClient"
import { useDefaultAgentId } from "./preferences"

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
