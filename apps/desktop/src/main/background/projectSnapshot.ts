import type { BackgroundTraySnapshot } from "../../shared/backgroundTray"

interface NamedProject {
  id: string
  name: string
}

interface ProjectActivity {
  projectId: string
  state: "working" | "waiting" | "exited"
}

/** List only projects with active agents, favoring work over waiting. */
export function trayProjectSnapshot(
  projects: readonly NamedProject[],
  sessions: readonly ProjectActivity[],
): BackgroundTraySnapshot {
  const stateByProject = new Map<string, "working" | "waiting">()
  for (const session of sessions) {
    if (session.state === "exited") continue
    const current = stateByProject.get(session.projectId)
    if (current !== "working") stateByProject.set(session.projectId, session.state)
  }
  return {
    projects: projects.flatMap((project) => {
      const state = stateByProject.get(project.id)
      return state ? [{ id: project.id, name: project.name, state }] : []
    }),
  }
}
