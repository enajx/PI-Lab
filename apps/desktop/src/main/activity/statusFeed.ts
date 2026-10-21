import { type PiLabDatabase, projects } from "@pi-lab/local-db"
import type { LiveAgentStatus } from "../../shared/agentStatus"
import type { ActivityRegistry } from "./registry"

/** Publish only changed indicator fields, with project names refreshed after project mutations. */
export class ActivityStatusFeed {
  private readonly listeners = new Set<(sessions: LiveAgentStatus[]) => void>()
  private unsubscribeRegistry: (() => void) | null = null
  private names = new Map<string, string>()
  private sessions: LiveAgentStatus[] = []
  private signature = ""

  constructor(
    private readonly db: PiLabDatabase,
    private readonly registry: ActivityRegistry,
  ) {}

  subscribe(listener: (sessions: LiveAgentStatus[]) => void): () => void {
    if (this.listeners.size === 0) {
      this.refreshNames()
      this.signature = ""
      this.unsubscribeRegistry = this.registry.subscribe(() => this.publish())
    }
    this.listeners.add(listener)
    listener(this.sessions)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.unsubscribeRegistry?.()
        this.unsubscribeRegistry = null
      }
    }
  }

  projectsChanged(): void {
    if (this.listeners.size === 0) return
    this.refreshNames()
    this.publish()
  }

  private refreshNames(): void {
    this.names = new Map(
      this.db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .all()
        .map((project) => [project.id, project.name]),
    )
  }

  private publish(): void {
    const sessions: LiveAgentStatus[] = this.registry.snapshot().sessions.flatMap((session) => {
      const projectName = this.names.get(session.projectId)
      if (session.state === "exited" || projectName === undefined) return []
      return [
        {
          sessionId: session.sessionId,
          projectId: session.projectId,
          projectName,
          agentId: session.agentId,
          state: session.state,
        },
      ]
    })
    const signature = JSON.stringify(sessions)
    if (signature === this.signature) return
    this.signature = signature
    this.sessions = sessions
    for (const listener of this.listeners) listener(sessions)
  }
}
