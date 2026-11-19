import { QueryClient } from "@tanstack/react-query"
import { createMachineSockets, createMachineTrpcClient, type PiLabTrpcClient } from "../trpc/client"
import { ConnectionStatus } from "../trpc/connectionStatus"

/**
 * One remote machine's connection in this document: its socket pair (calls
 * and terminal output, renderer/trpc/serverLinks.ts), their status, a tRPC
 * client over them, and its own query cache (tRPC query keys do not name the
 * server, so each machine needs its own). Created on first use, closed when
 * the machine is removed.
 */
export interface MachineRuntime {
  machineId: string
  status: ConnectionStatus
  client: PiLabTrpcClient
  queryClient: QueryClient
  close: () => Promise<void>
}

const runtimes = new Map<string, MachineRuntime>()

export function machineRuntime(machineId: string): MachineRuntime {
  const existing = runtimes.get(machineId)
  if (existing) return existing
  const status = new ConnectionStatus()
  const sockets = createMachineSockets(machineId, status)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: false } },
  })
  // As for the local server (AppProviders): after the calls socket opens again, refetch.
  const stopReopen = status.onReopened((name) => {
    if (name === "calls") void queryClient.invalidateQueries()
  })
  const runtime: MachineRuntime = {
    machineId,
    status,
    client: createMachineTrpcClient(sockets),
    queryClient,
    close: async () => {
      stopReopen()
      queryClient.clear()
      await sockets.close()
    },
  }
  runtimes.set(machineId, runtime)
  return runtime
}

/** Close the connections of machines no longer in `machineIds` (removed ones). */
export function closeRemovedMachines(machineIds: ReadonlySet<string>): void {
  for (const [machineId, runtime] of runtimes) {
    if (machineIds.has(machineId)) continue
    runtimes.delete(machineId)
    void runtime.close()
  }
}
