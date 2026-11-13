import { useCallback, useEffect, useMemo, useState } from "react"
import type { BuildOutputEvent, BuildResult } from "../../../../../../main/trpc/pdf/pdf"
import type { PiLabTrpcClient } from "../../../../../trpc/client"
import { publishLatexBuild } from "../../../components/StatusBar/latexBuildStore"

/** Most live output kept per build, so a long build cannot grow memory without limit. */
const MAX_LIVE_LOG = 100_000

interface Fingerprint {
  mtimeMs: number
  size: number
}

interface BuildStatus {
  message: string
  log: string
}

interface BuildState {
  state: "building" | "complete" | "failed"
  failedOutputs: Record<string, Fingerprint>
}

interface BuildFailure {
  source: string
  output: string | null
  log: string
}

/** Live output of one compile, from the `pdf.onBuildOutput` subscription. */
interface RunningBuild {
  text: string
  firstBuild: boolean
  downloading: boolean
  ended: boolean
}

interface BuildScope {
  client: PiLabTrpcClient
  workspaceId: string
  live: boolean
  pending: number
  failures: BuildFailure[]
  failedOutputs: Record<string, Fingerprint>
  lastLog: string
  /** Compiles seen on the live output stream since the last idle point, by build id. */
  running: Map<number, RunningBuild>
  /** Why the live output stream failed, shown at the top of the log; null while it works. */
  streamError: string | null
}

interface BuildSnapshot {
  scope: BuildScope
  status: BuildStatus
  pdfBuildState: BuildState
}

/**
 * Coordinate all roots in one workspace without discarding independent build failures.
 *
 * @param onBuilt called after each successful build with the PDF path the
 *   server returned (it follows the configured output folder) and the saved source
 */
export function useLatexBuild(
  client: PiLabTrpcClient,
  workspaceId: string,
  onSaved: ((relPath: string) => void) | undefined,
  onBuilt: ((pdfRelPath: string, sourceRelPath: string) => void) | undefined,
): {
  saved: (relPath: string) => void
  track: (relPath: string, build: Promise<BuildResult>) => void
  status: BuildStatus | null
  pdfBuildState: BuildState | null
} {
  const scope = useMemo<BuildScope>(
    () => ({
      client,
      workspaceId,
      live: false,
      pending: 0,
      failures: [],
      failedOutputs: {},
      lastLog: "",
      running: new Map(),
      streamError: null,
    }),
    [client, workspaceId],
  )
  const [snapshot, setSnapshot] = useState<BuildSnapshot | null>(null)

  /**
   * Publish an immutable view while keeping pending operations in the owning
   * scope. While building, the log is the live compiler output (when any has
   * arrived) and the message says when TeX packages are being downloaded.
   */
  const publish = useCallback((): void => {
    if (!scope.live) return
    const state = scope.pending > 0 ? "building" : scope.failures.length ? "failed" : "complete"
    const active = [...scope.running.values()].filter((build) => !build.ended)
    const liveLog = [...scope.running.values()].map((build) => build.text).join("\n")
    const finishedLog = scope.failures.length
      ? scope.failures.map((failure) => `${failure.source}\n${failure.log}`).join("\n\n")
      : scope.lastLog
    const message =
      state === "building"
        ? active.some((build) => build.firstBuild)
          ? "First build: downloading TeX packages…"
          : active.some((build) => build.downloading)
            ? "Downloading TeX packages…"
            : "Building LaTeX…"
        : state === "failed"
          ? "LaTeX build failed"
          : "LaTeX build complete"
    publishLatexBuild(scope.workspaceId, { state, message })
    setSnapshot({
      scope,
      status: {
        message,
        log: [scope.streamError, state === "building" && liveLog !== "" ? liveLog : finishedLog]
          .filter((part) => part !== null)
          .join("\n"),
      },
      pdfBuildState: { state, failedOutputs: { ...scope.failedOutputs } },
    })
  }, [scope])

  useEffect(() => {
    scope.live = true
    /** Apply one live output event to the build it belongs to. */
    const apply = (event: BuildOutputEvent): void => {
      if (event.kind === "start") {
        scope.running.set(event.buildId, {
          text: "",
          firstBuild: event.firstBuild,
          downloading: false,
          ended: false,
        })
      }
      const build = scope.running.get(event.buildId)
      if (!build) return
      if (event.kind === "chunk") build.text = (build.text + event.text).slice(-MAX_LIVE_LOG)
      if (event.kind === "downloading") build.downloading = true
      if (event.kind === "end") build.ended = true
      if (scope.pending > 0) publish()
    }
    const subscription = scope.client.pdf.onBuildOutput.subscribe(
      { workspaceId: scope.workspaceId },
      {
        onData: apply,
        onError: (cause: unknown) => {
          // Builds still run and report their full log at the end; the next
          // published status shows why live output is missing.
          scope.streamError = `Live build output is unavailable: ${String(cause)}`
        },
      },
    )
    return () => {
      scope.live = false
      subscription.unsubscribe()
      publishLatexBuild(scope.workspaceId, null)
    }
  }, [scope, publish])

  /**
   * Show one build of the root `relPath` (one this hook started, or one started
   * elsewhere such as Start draft's): status and log while it runs and after,
   * and `onBuilt` when it succeeds.
   */
  const track = useCallback(
    (relPath: string, build: Promise<BuildResult>): void => {
      if (!scope.live) return
      scope.pending += 1
      publish()
      void build
        .then(async (result) => {
          if (!scope.live) return
          scope.lastLog = result.log
          if (result.success) {
            delete scope.failedOutputs[result.relPath]
            scope.failures = scope.failures.filter(
              (failure) =>
                failure.output !== result.relPath &&
                !(failure.output === null && failure.source === relPath),
            )
            onBuilt?.(result.relPath, relPath)
            return
          }
          const failure: BuildFailure = { source: relPath, output: result.relPath, log: result.log }
          scope.failures = scope.failures.filter(
            (previous) =>
              previous.output !== result.relPath &&
              !(previous.output === null && previous.source === relPath),
          )
          scope.failures.push(failure)
          publish()
          const failed = await client.files.stat
            .query({ workspaceId, relPath: result.relPath })
            .catch((cause: unknown) => {
              failure.log += `\nCould not inspect failed PDF output: ${String(cause)}`
              return null
            })
          if (!scope.live || !scope.failures.includes(failure)) return
          if (failed?.exists)
            scope.failedOutputs[result.relPath] = { mtimeMs: failed.mtimeMs, size: failed.size }
        })
        .catch((cause: unknown) => {
          if (!scope.live) return
          scope.failures = scope.failures.filter(
            (failure) => failure.output !== null || failure.source !== relPath,
          )
          scope.failures.push({ source: relPath, output: null, log: String(cause) })
        })
        .finally(() => {
          scope.pending -= 1
          if (scope.pending === 0) scope.running.clear()
          publish()
        })
    },
    [client, workspaceId, onBuilt, scope, publish],
  )

  const saved = useCallback(
    (relPath: string): void => {
      onSaved?.(relPath)
      if (!/\.tex$/i.test(relPath) || !scope.live) return
      track(relPath, client.pdf.build.mutate({ workspaceId, relPath }))
    },
    [client, workspaceId, onSaved, scope, track],
  )

  return {
    saved,
    track,
    status: snapshot?.scope === scope ? snapshot.status : null,
    pdfBuildState: snapshot?.scope === scope ? snapshot.pdfBuildState : null,
  }
}
