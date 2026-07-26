import { TRPCError } from "@trpc/server"

const nonGitLaunches = new Set<string>()

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

/**
 * Keep the non-Git single-agent rule atomic across every public launch entry.
 * The reservation spans daemon spawn through activity tracking, so two requests
 * cannot both observe an empty monitor before either session becomes visible.
 */
export async function withAgentLaunchGuard<T>(options: AgentLaunchGuardOptions<T>): Promise<T> {
  const release = acquireAgentLaunchSlot(options)
  try {
    return await options.launch()
  } finally {
    release()
  }
}
