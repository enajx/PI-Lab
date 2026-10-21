import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react"
import type { LiveAgentStatus } from "../../../shared/agentStatus"
import { useTRPCClient } from "../../trpc/react"
import { deriveProjectStates, type ProjectState } from "./index/utils/deriveProjectState"

type ProjectActivityStates = ReadonlyMap<string, ProjectState>
interface AgentStatusSnapshot {
  data: LiveAgentStatus[] | undefined
  error: Error | null
}
const ProjectActivityContext = createContext<ProjectActivityStates>(new Map())
const AgentStatusContext = createContext<AgentStatusSnapshot>({ data: undefined, error: null })

/** Share one changed-state subscription across shell indicators and the title bar. */
export function ProjectActivityProvider({ children }: { children: ReactNode }) {
  const client = useTRPCClient()
  const [snapshot, setSnapshot] = useState<AgentStatusSnapshot>({ data: undefined, error: null })
  useEffect(() => {
    const subscription = client.sessions.onStatus.subscribe(undefined, {
      onData: (data) => setSnapshot({ data, error: null }),
      onError: (error) => setSnapshot((previous) => ({ ...previous, error })),
    })
    return () => subscription.unsubscribe()
  }, [client])
  const states = useMemo(() => deriveProjectStates(snapshot.data ?? []), [snapshot.data])
  return (
    <AgentStatusContext.Provider value={snapshot}>
      <ProjectActivityContext.Provider value={states}>{children}</ProjectActivityContext.Provider>
    </AgentStatusContext.Provider>
  )
}

/** Read the shared live-session list and its delivery state. */
export function useAgentStatus(): AgentStatusSnapshot {
  return useContext(AgentStatusContext)
}

/** Read the shared project status, where waiting takes priority over working. */
export function useProjectActivityState(projectId: string): ProjectState {
  return useContext(ProjectActivityContext).get(projectId) ?? "idle"
}

/** Read all project statuses for a list that renders many projects. */
export function useProjectActivityStates(): ProjectActivityStates {
  return useContext(ProjectActivityContext)
}
