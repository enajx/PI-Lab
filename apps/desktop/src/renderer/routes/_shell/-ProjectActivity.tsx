import { useQuery } from "@tanstack/react-query"
import { createContext, type ReactNode, useContext, useMemo } from "react"
import { useTRPC } from "../../trpc/react"
import { deriveProjectStates, type ProjectState } from "./index/utils/deriveProjectState"

type ProjectActivityStates = ReadonlyMap<string, ProjectState>
const ProjectActivityContext = createContext<ProjectActivityStates>(new Map())

/** Own the one-second activity poll for the whole shell, including non-dashboard routes. */
export function ProjectActivityProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC()
  const activity = useQuery(
    trpc.sessions.activity.queryOptions(undefined, { staleTime: 0, refetchInterval: 1_000 }),
  )
  const states = useMemo(() => deriveProjectStates(activity.data ?? []), [activity.data])
  return (
    <ProjectActivityContext.Provider value={states}>{children}</ProjectActivityContext.Provider>
  )
}

/** Read the shared project status, where waiting takes priority over working. */
export function useProjectActivityState(projectId: string): ProjectState {
  return useContext(ProjectActivityContext).get(projectId) ?? "idle"
}

/** Read all project statuses for a list that renders many projects. */
export function useProjectActivityStates(): ProjectActivityStates {
  return useContext(ProjectActivityContext)
}
