import type { BackgroundTraySnapshot } from "../../shared/backgroundTray"

interface NamedProject {
  id: string
  name: string
  lastActivityAt: number
}

interface ProjectActivity {
  projectId: string
  state: "working" | "waiting" | "exited"
}

/** List recently opened or active projects, retaining every live agent. */
export function trayProjectSnapshot(
  projects: readonly NamedProject[],
  sessions: readonly ProjectActivity[],
  now: number,
): BackgroundTraySnapshot {
  const stateByProject = new Map<string, "working" | "waiting">()
  for (const session of sessions) {
    if (session.state === "exited") continue
    const current = stateByProject.get(session.projectId)
    if (current !== "working") stateByProject.set(session.projectId, session.state)
  }
  return {
    projects: [...projects]
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .flatMap((project) => {
        const state = stateByProject.get(project.id)
        return state || project.lastActivityAt >= now - 7 * 86400000
          ? [{ id: project.id, name: project.name, state: state ?? "idle" }]
          : []
      }),
  }
}
