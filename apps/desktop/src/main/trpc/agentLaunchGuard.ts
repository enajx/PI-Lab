import { TRPCError } from "@trpc/server"
import { agentLaunchLifecycle } from "../agents/launchLifecycle"

const nonGitLaunches = new Set<string>()
const pendingLaunches = new Map<string, Promise<void>>()

/** Include launch setup before an agent is registered with the activity monitor. */
export function hasPendingAgentLaunch(projectId: string): boolean {
  return pendingLaunches.has(projectId)
}

interface AgentLaunchGuardOptions<T> {
  projectId: string
  gitAvailable: boolean
  liveAgentCount: () => number
  launch: () => Promise<T>
}

interface AgentLaunchSlotOptions {
  projectId: string
  gitAvailable: boolean
  liveAgentCount: () => number
}

/** Reserve the project's only non-Git agent slot until the returned release runs. */
export function acquireAgentLaunchSlot(options: AgentLaunchSlotOptions): () => void {
  if (options.gitAvailable) return () => {}

  if (nonGitLaunches.has(options.projectId) || options.liveAgentCount() > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "A non-Git project can run only one agent at a time. Close the live agent or Initialize Git.",
    })
  }

  nonGitLaunches.add(options.projectId)
  let released = false
  return () => {
    if (released) return
    released = true
    nonGitLaunches.delete(options.projectId)
  }
}

/** Coordinate workspace selection through registration, independently per project. */
export async function withAgentLaunchGuard<T>(options: AgentLaunchGuardOptions<T>): Promise<T> {
  return agentLaunchLifecycle.run(() => coordinateLaunch(options))
}

/** Hold the project reservation until the launch has registered its session. */
async function coordinateLaunch<T>(options: AgentLaunchGuardOptions<T>): Promise<T> {
  const release = acquireAgentLaunchSlot(options)
  const previous = pendingLaunches.get(options.projectId)
  let complete!: () => void
  const pending = new Promise<void>((resolve) => {
    complete = resolve
  })
  pendingLaunches.set(options.projectId, pending)
  try {
    await previous
    return await options.launch()
  } finally {
    complete()
    if (pendingLaunches.get(options.projectId) === pending)
      pendingLaunches.delete(options.projectId)
    release()
  }
}
