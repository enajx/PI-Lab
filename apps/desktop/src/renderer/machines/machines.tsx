import { QueryClientProvider, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { createContext, type ReactNode, useContext, useEffect } from "react"
import type { DeviceMachineSettings, MachineSummary } from "../../main/machines/machineConnections"
import { desktopIpc } from "../trpc/client"
import { type ConnectionState, useStatusState } from "../trpc/connectionStatus"
import { TRPCProvider } from "../trpc/react"
import type { ProjectListItem } from "../trpc/types"
import { closeRemovedMachines, type MachineRuntime, machineRuntime } from "./machineRuntime"

export type { DeviceMachineSettings, MachineSummary }

const MachineContext = createContext<MachineRuntime | null>(null)

/**
 * Point the tRPC hooks below at one machine's server: `null` is the local
 * server (the app's root providers, nothing changes); a machine id gives its
 * own tRPC client and query cache. Terminals read the scope for their client
 * and connection status. App-wide parts (tray, notifications, updates,
 * settings) stay outside every scope, on the local server.
 */
export function MachineScope({
  machineId,
  children,
}: {
  machineId: string | null
  children: ReactNode
}): ReactNode {
  if (machineId === null) return children
  const runtime = machineRuntime(machineId)
  return (
    <MachineContext.Provider value={runtime}>
      <QueryClientProvider client={runtime.queryClient}>
        <TRPCProvider trpcClient={runtime.client} queryClient={runtime.queryClient}>
          {children}
        </TRPCProvider>
      </QueryClientProvider>
    </MachineContext.Provider>
  )
}

/** The remote machine the surrounding {@link MachineScope} names, or null for the local server. */
export function useMachineScope(): MachineRuntime | null {
  return useContext(MachineContext)
}

export const MACHINES_QUERY_KEY = ["desktop", "machines", "list"] as const

/**
 * Whether machine UI (badges, the machine filter, the Machines group, the New
 * project machine picker, the default machine) shows: only once a machine is
 * added, so a single computer looks as before. The one place this rule lives.
 * A machine added means the multi-machine toggle is on (adding turns it on,
 * Off is refused while one is added), so while the toggle is off no machine
 * UI shows; with the toggle on and no machine only Settings > Machines changes.
 */
export function showMachineUi(machines: MachineSummary[]): boolean {
  return machines.length > 0
}

export const DEVICE_SETTINGS_QUERY_KEY = ["desktop", "machines", "deviceSettings"] as const

/** Where the device settings come from: Electron main over IPC; renderer unit tests replace it. */
let readDeviceSettings: () => Promise<DeviceMachineSettings> = () =>
  desktopIpc().desktop.machines.deviceSettings.query()

/** Renderer unit tests (no Electron preload) read the device settings from here instead. */
export function setDeviceSettingsSourceForTests(
  source: () => Promise<DeviceMachineSettings>,
): void {
  readDeviceSettings = source
}

/** This device's "Local server" setting and default machine (null: this Mac), from Electron main. */
export function useDeviceMachineSettings(): DeviceMachineSettings | null {
  const query = useQuery({
    queryKey: DEVICE_SETTINGS_QUERY_KEY,
    queryFn: () => readDeviceSettings(),
  })
  if (query.isError) throw query.error
  return query.data ?? null
}

/** Where the machines list comes from: Electron main over IPC; renderer unit tests replace it. */
let listMachines: () => Promise<MachineSummary[]> = () => desktopIpc().desktop.machines.list.query()

/** Renderer unit tests (no Electron preload) list machines from here instead. */
export function setMachinesSourceForTests(source: () => Promise<MachineSummary[]>): void {
  listMachines = source
}

/**
 * The machines this app connects to (Electron main, `desktop.machines.list`).
 * Call it outside every {@link MachineScope}: the list lives in the root
 * query cache. Connections of machines that left the list are closed.
 */
export function useMachines(refetchIntervalMs: number | false): MachineSummary[] | null {
  const query = useQuery({
    queryKey: MACHINES_QUERY_KEY,
    queryFn: () => listMachines(),
    refetchInterval: refetchIntervalMs,
  })
  const data = query.data
  useEffect(() => {
    if (data) closeRemovedMachines(new Set(data.map((machine) => machine.machineId)))
  }, [data])
  if (query.isError) throw query.error
  return data ?? null
}

/** The connection state of a machine's sockets (the status bar's words). */
export function useMachineState(machineId: string): ConnectionState {
  return useStatusState(machineRuntime(machineId).status)
}

const CACHE_PREFIX = "pi-lab.machineProjects."

function readCachedProjects(machineId: string): ProjectListItem[] | undefined {
  try {
    const text = window.localStorage.getItem(`${CACHE_PREFIX}${machineId}`)
    return text === null ? undefined : (JSON.parse(text) as ProjectListItem[])
  } catch {
    return undefined
  }
}

function writeCachedProjects(machineId: string, projects: ProjectListItem[]): void {
  try {
    window.localStorage.setItem(`${CACHE_PREFIX}${machineId}`, JSON.stringify(projects))
  } catch {
    // The cache only fills the list while the machine is offline after a restart.
  }
}

/** Forget a removed machine's cached project list. */
export function forgetCachedProjects(machineId: string): void {
  window.localStorage.removeItem(`${CACHE_PREFIX}${machineId}`)
}

/** One machine's projects: the last list it gave (cached here). */
export interface MachineProjects {
  machine: MachineSummary
  projects: ProjectListItem[]
  error: string | null
}

/**
 * The project lists of the remote machines, from their own servers. The last
 * list each machine gave is kept in localStorage, so a machine that is offline
 * (also after a restart of the app) still shows its projects with their last
 * known data.
 */
export function useRemoteProjects(machines: MachineSummary[]): MachineProjects[] {
  const queryClient = useQueryClient()
  const ids = machines.map((machine) => machine.machineId).join("\n")
  // A machine whose calls socket opens again (back online, or its server restarted) is read again.
  useEffect(() => {
    const stops = ids
      .split("\n")
      .filter((id) => id !== "")
      .map((machineId) =>
        machineRuntime(machineId).status.onReopened((name) => {
          if (name === "calls") {
            void queryClient.invalidateQueries({ queryKey: ["machine-projects", machineId] })
          }
        }),
      )
    return () => {
      for (const stop of stops) stop()
    }
  }, [ids, queryClient])
  const results = useQueries({
    queries: machines.map((machine) => ({
      queryKey: ["machine-projects", machine.machineId],
      queryFn: async () => {
        const projects = await machineRuntime(machine.machineId).client.projects.list.query()
        writeCachedProjects(machine.machineId, projects)
        return projects
      },
      initialData: () => readCachedProjects(machine.machineId),
      initialDataUpdatedAt: 0,
    })),
  })
  return machines.map((machine, index) => ({
    machine,
    projects: results[index]?.data ?? [],
    error: results[index]?.error?.message ?? null,
  }))
}
