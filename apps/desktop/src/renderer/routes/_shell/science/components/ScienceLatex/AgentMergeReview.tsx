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

/** A conflicted file the agent is not given: a binary file (a figure) or a modify/delete conflict. */
interface OtherConflict {
  relPath: string
  kind: "binary" | "deleted-mine" | "deleted-overleaf"
}

type ReviewState =
  | { kind: "running" }
  | { kind: "ready"; files: MergedFile[]; others: OtherConflict[] }
  | { kind: "failed"; message: string }

/** Error shown when the merge run has no status record to wait on. */
const NO_RECORD_MESSAGE =
  "The merge agent stopped without a result. Reject and try again, or settle the files yourself."

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

/** What a conflict the agent cannot merge is, for its line in the review. */
function otherConflictLabel(kind: OtherConflict["kind"], t: (english: string) => string): string {
  if (kind === "binary") return t("Binary file (such as a figure): choose which version to keep.")
  if (kind === "deleted-mine") return t("Deleted here, changed on Overleaf.")
  return t("Deleted on Overleaf, changed here.")
}

/**
 * "Ask agent to merge": runs the project agent on the conflicted text files of
 * the paper's merge (from `paper.conflicts`), then shows what it changed in
 * each. Binary files (figures) and modify/delete conflicts are not given to
 * the agent: each gets Keep mine / Keep Overleaf, applied only on Accept
 * (`paper.resolveFile`), so Reject leaves them in conflict. With no text file
 * in conflict the agent is not run. Nothing is pushed until the user accepts;
 * rejecting puts the conflict markers back.
 */
export function AgentMergeReview({
  projectId,
  workspaceId,
  pending,
  error,
  onAccept,
  onReject,
}: {
  projectId: string
  workspaceId: string
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
  // The user's choice for each file in `others`, applied on Accept.
  const [choices, setChoices] = useState<Record<string, "mine" | "overleaf">>({})
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const run = async (): Promise<{ files: MergedFile[]; others: OtherConflict[] }> => {
      const conflicts = await client.paper.conflicts.query({ projectId })
      const others: OtherConflict[] = []
      const textFiles: string[] = []
      for (const conflict of conflicts) {
        if (conflict.kind === "text") textFiles.push(conflict.relPath)
        else others.push({ relPath: conflict.relPath, kind: conflict.kind })
      }
      if (textFiles.length === 0) return { files: [], others }
      const before = await Promise.all(
        textFiles.map((relPath) => readText(client, workspaceId, relPath)),
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
      // A null record (no run known) ends the wait and is reported below.
      while (live && record?.running) {
        await new Promise((resolve) => setTimeout(resolve, MERGE_POLL_MS))
        record = (await client.workflows.status.query({ projectId })).latexMerge
      }
      if (!live) return { files: [], others: [] }
      if (record === null) throw new Error(NO_RECORD_MESSAGE)
      if (record.errorMessage) throw new Error(record.errorMessage)
      const after = await Promise.all(
        textFiles.map((relPath) => readText(client, workspaceId, relPath)),
      )
      const files = textFiles.map((relPath, index) => ({
        relPath,
        before: before[index] ?? "",
        after: after[index] ?? "",
      }))
      return { files, others }
    }
    run().then(
      (merged) => {
        if (live) setState({ kind: "ready", ...merged })
      },
      (cause: unknown) => {
        if (live) setState({ kind: "failed", message: String(cause) })
      },
    )
    return () => {
      live = false
    }
  }, [client, projectId, workspaceId])

  /** Settle each other file with the chosen side, then accept (commit and push). */
  const accept = async (): Promise<void> => {
    if (state.kind !== "ready") return
    setApplying(true)
    setApplyError(null)
    for (const file of state.others) {
      const choice = choices[file.relPath]
      if (!choice) continue
      const failed = await client.paper.resolveFile
        .mutate({ projectId, relPath: file.relPath, choice })
        .then(
          () => null,
          (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
        )
      if (failed !== null) {
        setApplyError(failed)
        setApplying(false)
        return
      }
    }
    setApplying(false)
    onAccept()
  }

  const unresolved =
    state.kind === "ready"
      ? state.files.filter((file) => /^(<{7}|>{7}) /m.test(file.after)).map((file) => file.relPath)
      : []
  const unchosen =
    state.kind === "ready" ? state.others.filter((file) => !choices[file.relPath]).length : 0
  const busy = pending || applying

  return (
    <PaperDialog
      testId="paper-agent-merge"
      title={t("Agent merge")}
      onClose={() => {
        // The agent may still write to the files; only Reject once it has finished.
        if (state.kind !== "running" && !busy) onReject()
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
          {state.others.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              {t("These files cannot be merged by the agent. Choose a version for each:")}
            </p>
          ) : null}
          {state.others.map((file) => (
            <div
              key={file.relPath}
              data-testid={`paper-agent-merge-file-${file.relPath}`}
              className="flex items-center gap-2 rounded border border-border px-2 py-1.5 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono" title={file.relPath}>
                  {file.relPath}
                </div>
                <div className="text-muted-foreground">{otherConflictLabel(file.kind, t)}</div>
              </div>
              {(["mine", "overleaf"] as const).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  aria-pressed={choices[file.relPath] === choice}
                  disabled={busy}
                  onClick={() => setChoices({ ...choices, [file.relPath]: choice })}
                  className="shrink-0 rounded border border-border px-2 py-1 hover:bg-accent disabled:opacity-50 aria-pressed:bg-primary aria-pressed:text-primary-foreground"
                >
                  {choice === "mine" ? t("Keep mine") : t("Keep Overleaf")}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      <DialogError error={applyError ?? error} />
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          data-testid="paper-agent-merge-reject"
          disabled={state.kind === "running" || busy}
          className="rounded border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          onClick={onReject}
        >
          {t("Reject")}
        </button>
        <button
          type="button"
          data-testid="paper-agent-merge-accept"
          disabled={state.kind !== "ready" || unresolved.length > 0 || unchosen > 0 || busy}
          className="rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"
          onClick={() => void accept()}
        >
          {t("Accept and sync")}
        </button>
      </div>
    </PaperDialog>
  )
}
