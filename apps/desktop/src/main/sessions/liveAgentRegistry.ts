import type { DaemonClient, ExitEvent } from "@skipper/pty-daemon"

/**
 * Per-project tally of *live* agent sessions, the input the start-agent-session
 * policy (AGENTS.md §8) needs to decide a workspace kind: the second concurrent
 * agent for a project must get its own worktree so it can't clobber the shared
 * main checkout.
 *
 * The registry is pure in-memory bookkeeping — it owns no PTYs and no DB rows.
 * It is fed two ways:
 *   - {@link register} is called the moment an agent session is spawned, before
 *     the next `start` can race in;
 *   - the daemon's `exit` event drains a session automatically, so a finished
 *     agent stops counting without the caller having to remember to deregister.
 *
 * Because a single `DaemonClient` fans `exit` out for *every* session, the
 * registry keeps a reverse `sessionId -> projectId` map: the exit event only
 * carries a `sessionId`, so that reverse lookup is how it knows which project's
 * tally to decrement. Unknown session ids (terminals, other features) are
 * ignored.
 *
 * It is injected into {@link AppContext} (not a module singleton) so each test
 * gets its own, and so a test can subscribe a fake/in-process daemon client.
 */
export class LiveAgentRegistry {
  /** projectId -> the set of its currently-live agent session ids. */
  private readonly byProject = new Map<string, Set<string>>()
  /** sessionId -> the project it belongs to (reverse index for exit events). */
  private readonly projectOf = new Map<string, string>()
  /** Clients we've already wired an `exit` listener onto (idempotent attach). */
  private readonly attached = new WeakSet<DaemonClient>()

  /** Bound so it can be added/removed as the same listener reference. */
  private readonly onExit = (event: ExitEvent): void => {
    this.deregister(event.sessionId)
  }

  /**
   * Subscribe to a daemon client's `exit` stream so finished sessions drain
   * automatically. Idempotent per client: wiring the same client twice is a
   * no-op, so callers can attach defensively on every `register`.
   */
  attach(client: DaemonClient): void {
    if (this.attached.has(client)) return
    this.attached.add(client)
    client.on("exit", this.onExit)
  }

  /** Stop listening to a client's `exit` stream (e.g. on supervisor dispose). */
  detach(client: DaemonClient): void {
    if (!this.attached.has(client)) return
    this.attached.delete(client)
    client.off("exit", this.onExit)
  }

  /**
   * Record a freshly-started agent session for a project. Called from the
   * session-start flow right after the PTY spawns, so a subsequent `start` for
   * the same project sees the bumped count.
   */
  register(projectId: string, sessionId: string): void {
    let set = this.byProject.get(projectId)
    if (!set) {
      set = new Set<string>()
      this.byProject.set(projectId, set)
    }
    set.add(sessionId)
    this.projectOf.set(sessionId, projectId)
  }

  /**
   * Forget a session (on its daemon `exit`, or explicitly). Decrements the
   * owning project's tally and cleans up empty buckets. Unknown ids are ignored.
   */
  deregister(sessionId: string): void {
    const projectId = this.projectOf.get(sessionId)
    if (projectId === undefined) return
    this.projectOf.delete(sessionId)
    const set = this.byProject.get(projectId)
    if (!set) return
    set.delete(sessionId)
    if (set.size === 0) this.byProject.delete(projectId)
  }

  /** How many agent sessions are currently live for a project. */
  liveAgentCount(projectId: string): number {
    return this.byProject.get(projectId)?.size ?? 0
  }
}
