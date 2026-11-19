import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, expect, test } from "vitest"
import type { ProjectListItem } from "../trpc/types"
import {
  type MachineSummary,
  setMachinesSourceForTests,
  useMachines,
  whileMachinesAdded,
} from "./machines"
import { hiddenProjectCount } from "./RemoteProjects"

function machine(machineId: string): MachineSummary {
  return {
    machineId,
    name: machineId,
    sshHost: machineId,
    addedAt: 0,
    state: "connected",
    error: null,
    version: null,
    updateAvailable: false,
    updating: false,
    updateError: null,
    updateProgress: null,
  } as MachineSummary
}

function project(id: string, hidden: boolean): ProjectListItem {
  return { id, archivedAt: hidden ? 1 : null } as unknown as ProjectListItem
}

function wrapperFor(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

afterEach(() => setMachinesSourceForTests(async () => []))

/** Stubbed machines source: one failed refetch keeps the last list instead of throwing. */
test("a failed refetch of the machine list keeps the last list", async () => {
  let calls = 0
  setMachinesSourceForTests(async () => {
    calls += 1
    if (calls > 1) throw new Error("IPC failed")
    return [machine("m1")]
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = renderHook(() => useMachines(50), { wrapper: wrapperFor(queryClient) })
  await waitFor(() => expect(view.result.current?.length).toBe(1))
  await waitFor(() => expect(calls).toBeGreaterThan(2))
  expect(view.result.current?.map((entry) => entry.machineId)).toEqual(["m1"])
  queryClient.clear()
})

/** Stubbed machines source: polling only while a machine is added; an invalidate still reads it. */
test("the sidebar polls the machine list only while a machine is added", async () => {
  let calls = 0
  let list: MachineSummary[] = []
  setMachinesSourceForTests(async () => {
    calls += 1
    return list
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = renderHook(() => useMachines(whileMachinesAdded(50)), {
    wrapper: wrapperFor(queryClient),
  })
  await waitFor(() => expect(view.result.current).toEqual([]))
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(calls).toBe(1)
  list = [machine("m1")]
  await queryClient.invalidateQueries({ queryKey: ["desktop", "machines", "list"] })
  await waitFor(() => expect(view.result.current?.length).toBe(1))
  const afterAdd = calls
  await waitFor(() => expect(calls).toBeGreaterThan(afterAdd + 1))
  queryClient.clear()
})

/** Plain data: the hidden count is unknown until every machine's list is known. */
test("the hidden count is null while a machine's project list is unknown", () => {
  const local = [project("a", false)]
  const known = { machine: machine("m1"), projects: [project("b", true)], error: null, known: true }
  const unknown = { machine: machine("m2"), projects: [], error: null, known: false }
  expect(hiddenProjectCount(local, null)).toBeNull()
  expect(hiddenProjectCount(undefined, [known])).toBeNull()
  expect(hiddenProjectCount(local, [known, unknown])).toBeNull()
  expect(hiddenProjectCount([...local, project("c", true)], [known])).toBe(2)
})
