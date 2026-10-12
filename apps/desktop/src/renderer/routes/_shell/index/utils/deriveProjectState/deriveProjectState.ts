/** Shared project status shown by the Dashboard card and sidebar. */
export type ProjectState = "idle" | "active" | "attention"

export interface ProjectActivity {
  projectId: string
  state: "working" | "waiting" | "exited"
}

/** Map live session activity to project status. Waiting takes priority over working. */
export function deriveProjectStates(
  activity: ReadonlyArray<ProjectActivity>,
): Map<string, ProjectState> {
  const projects = new Map<string, ProjectState>()
  for (const record of activity) {
    if (record.state === "exited") continue
    const current = projects.get(record.projectId)
    if (record.state === "waiting") projects.set(record.projectId, "attention")
    else if (current !== "attention") projects.set(record.projectId, "active")
  }
  return projects
}
