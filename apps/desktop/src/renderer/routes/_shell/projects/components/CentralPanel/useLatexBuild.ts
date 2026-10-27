import { useCallback, useEffect, useMemo, useState } from "react"
import type { PiLabTrpcClient } from "../../../../../trpc/client"

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

interface BuildScope {
  client: PiLabTrpcClient
  workspaceId: string
  live: boolean
  pending: number
  failures: BuildFailure[]
  failedOutputs: Record<string, Fingerprint>
  lastLog: string
}

interface BuildSnapshot {
  scope: BuildScope
  status: BuildStatus
  pdfBuildState: BuildState
}

/** Coordinate all roots in one workspace without discarding independent build failures. */
export function useLatexBuild(
  client: PiLabTrpcClient,
  workspaceId: string,
  onSaved: ((relPath: string) => void) | undefined,
): {
  saved: (relPath: string) => void
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
    }),
    [client, workspaceId],
  )
  const [snapshot, setSnapshot] = useState<BuildSnapshot | null>(null)
  useEffect(() => {
    scope.live = true
    return () => {
      scope.live = false
    }
  }, [scope])

  const saved = useCallback(
    (relPath: string): void => {
      onSaved?.(relPath)
      if (!/\.tex$/i.test(relPath) || !scope.live) return
      /** Publish an immutable view while keeping pending operations in the owning scope. */
      const publish = (): void => {
        if (!scope.live) return
        const state = scope.pending > 0 ? "building" : scope.failures.length ? "failed" : "complete"
        setSnapshot({
          scope,
          status: {
            message:
              state === "building"
                ? "Building LaTeX…"
                : state === "failed"
                  ? "LaTeX build failed"
                  : "LaTeX build complete",
            log: scope.failures.length
              ? scope.failures.map((failure) => `${failure.source}\n${failure.log}`).join("\n\n")
              : scope.lastLog,
          },
          pdfBuildState: { state, failedOutputs: { ...scope.failedOutputs } },
        })
      }
      scope.pending += 1
      publish()
      void client.pdf.build
        .mutate({ workspaceId, relPath })
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
          publish()
        })
    },
    [client, workspaceId, onSaved, scope],
  )

  return {
    saved,
    status: snapshot?.scope === scope ? snapshot.status : null,
    pdfBuildState: snapshot?.scope === scope ? snapshot.pdfBuildState : null,
  }
}
