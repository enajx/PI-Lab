import { useEffect, useState } from "react"
import { useTranslate } from "../../../../../i18n/language"
import { useTRPCClient } from "../../../../../trpc/react"
import { ProjectDiff } from "../../../components/ProjectDiff"
import { DialogError, PaperDialog } from "./PaperSyncBar"

/** How often to check whether the merge agent has finished. */
const MERGE_POLL_MS = 500

/** One conflicted file before and after the agent merge. */
interface MergedFile {
  relPath: string
  before: string
  after: string
}

type ReviewState =
  | { kind: "running" }
  | { kind: "ready"; files: MergedFile[] }
  | { kind: "failed"; message: string }

/** Read a paper file as text; anything else (missing, binary, too large) is an error. */
async function readText(
  client: ReturnType<typeof useTRPCClient>,
  workspaceId: string,
  relPath: string,
): Promise<string> {
  const snapshot = await client.files.read.query({ workspaceId, relPath })
  if (snapshot.status !== "text")
    throw new Error(`${relPath}: cannot read as text (${snapshot.status})`)
  return snapshot.content
}

/**
 * "Ask agent to merge": runs the project agent on the conflicted paper files,
 * then shows what it changed in each file. Nothing is pushed until the user
 * accepts; rejecting puts the conflict markers back.
 */
export function AgentMergeReview({
  projectId,
  workspaceId,
  files,
  pending,
  error,
  onAccept,
  onReject,
}: {
  projectId: string
  workspaceId: string
  files: string[]
  /** True while the Accept sync or the Reject restore is running. */
  pending: boolean
  /** A Sync or restore failure, shown here because the dialog covers the bar. */
  error: string | null
  onAccept: () => void
  onReject: () => void
}) {
  const t = useTranslate()
  const client = useTRPCClient()
  const [state, setState] = useState<ReviewState>({ kind: "running" })

  useEffect(() => {
    let live = true
    const run = async (): Promise<MergedFile[]> => {
      const before = await Promise.all(
        files.map((relPath) => readText(client, workspaceId, relPath)),
      )
      const started = await client.workflows.run.mutate({
        projectId,
        task: "latex-merge",
        force: true,
      })
      // `run` returns while the agent is still working; wait for it to finish.
      let record = started.running
        ? (await client.workflows.status.query({ projectId })).latexMerge
        : started
      while (live && record?.running !== false) {
        await new Promise((resolve) => setTimeout(resolve, MERGE_POLL_MS))
        record = (await client.workflows.status.query({ projectId })).latexMerge
      }
      if (!live) return []
      if (record?.errorMessage) throw new Error(record.errorMessage)
      const after = await Promise.all(
        files.map((relPath) => readText(client, workspaceId, relPath)),
      )
      return files.map((relPath, index) => ({
        relPath,
        before: before[index] ?? "",
        after: after[index] ?? "",
      }))
    }
    run().then(
      (merged) => {
        if (live) setState({ kind: "ready", files: merged })
      },
      (cause: unknown) => {
        if (live) setState({ kind: "failed", message: String(cause) })
      },
    )
    return () => {
      live = false
    }
  }, [client, files, projectId, workspaceId])

  const unresolved =
    state.kind === "ready"
      ? state.files.filter((file) => /^(<{7}|>{7}) /m.test(file.after)).map((file) => file.relPath)
      : []

  return (
    <PaperDialog
      testId="paper-agent-merge"
      title={t("Agent merge")}
      onClose={() => {
        // The agent may still write to the files; only Reject once it has finished.
        if (state.kind !== "running" && !pending) onReject()
      }}
    >
      {state.kind === "running" ? (
        <p role="status" className="mt-2 text-muted-foreground text-xs">
          {t("The project agent is merging the conflicted files…")}
        </p>
      ) : null}
      {state.kind === "failed" ? (
        <p role="alert" className="mt-2 cursor-text select-text text-destructive text-xs">
          {state.message}
        </p>
      ) : null}
      {state.kind === "ready" ? (
        <div className="mt-2 flex min-h-0 flex-col gap-2 overflow-y-auto">
          <p className="text-muted-foreground text-xs">
            {t("Review the merge. Accept commits it and pushes to Overleaf.")}
          </p>
          {unresolved.length > 0 ? (
            <p role="alert" className="text-destructive text-xs">
              {t("Conflict markers are still present in:")} {unresolved.join(", ")}
            </p>
          ) : null}
          {state.files.map((file) => (
            <ProjectDiff
              key={file.relPath}
              title={file.relPath}
              original={file.before}
              proposed={file.after}
            />
          ))}
        </div>
      ) : null}
      <DialogError error={error} />
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          data-testid="paper-agent-merge-reject"
          disabled={state.kind === "running" || pending}
          className="rounded border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          onClick={onReject}
        >
          {t("Reject")}
        </button>
        <button
          type="button"
          data-testid="paper-agent-merge-accept"
          disabled={state.kind !== "ready" || unresolved.length > 0 || pending}
          className="rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"
          onClick={onAccept}
        >
          {t("Accept and sync")}
        </button>
      </div>
    </PaperDialog>
  )
}
