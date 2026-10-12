import type { WorkflowTask } from "@pi-lab/local-db"
import { cn } from "@pi-lab/ui"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { WorkflowOutputEvent } from "../../../main/trpc/workflows"
import { Markdown } from "../../routes/_shell/projects/components/RightSidebar/components/Markdown"
import { useTRPCClient } from "../../trpc/react"
import { formatRelativeTime } from "./relativeTime"

/**
 * The result window for a background project workflow ("Project summary" /
 * "Fetch remote experiments"). Opened by the control while a run is in flight
 * (to watch it live) or when it is done/errored (to review the outcome). It has
 * two stacked regions so a run is never opaque and never disappears silently
 * (AGENTS.md — no silent failures):
 *
 *   1. A live **agent activity log** at the top — a monospace, auto-scrolling
 *      region subscribed to `workflows.onOutput`, replaying this run's buffered
 *      output and streaming subsequent chunks as the agent prints them. This is
 *      the "what is happening" view.
 *   2. The **report** below — while running it shows a "working…" state; when
 *      done it renders the printed summary as MARKDOWN (so `**bold**`/`#` render,
 *      not raw); an errored run shows the failure. A guidance line (check
 *      RESEARCH.md / Analysis) and a "Last checked: <relative>" line accompany a
 *      non-error report.
 *
 * Structurally mirrors the app's other centered dialogs: a click-to-dismiss
 * backdrop, closable via Escape, a backdrop click, or the Close button.
 */

/** Cap on retained live-log text in the window, matching the server's buffer. */
const MAX_LOG_CHARS = 256 * 1024

export function WorkflowResultDialog({
  projectId,
  task,
  title,
  reportHeading,
  projectName,
  running,
  result,
  errorMessage,
  lastCheckedAt,
  guidance,
  onRecheck,
  onClose,
}: {
  projectId: string
  task: WorkflowTask
  title: string
  reportHeading: string
  projectName: string
  /** True while the run is in flight — the report shows a "working…" state. */
  running: boolean
  result: string
  errorMessage: string | null
  lastCheckedAt: number
  guidance: string
  /** Force a fresh run in place; resolves once the new run has started. */
  onRecheck: () => Promise<unknown>
  onClose: () => void
}) {
  const client = useTRPCClient()
  const logRef = useRef<HTMLDivElement | null>(null)
  const [command, setCommand] = useState<string | null>(null)
  const [log, setLog] = useState("")
  // Bumped when Recheck starts a fresh run: forces the subscription effect to
  // re-attach to the *new* run's live stream (a force run replaces the server
  // stream, so the prior subscription would otherwise miss it).
  const [runNonce, setRunNonce] = useState(0)
  const [rechecking, setRechecking] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  // Subscribe to the run's live output: replay its buffer, then stream. A
  // `cancelled` guard keeps a fast unmount (React 19 StrictMode) from writing
  // into a torn-down component. A missing subscriber (no run for the key) simply
  // completes empty; the report region still renders from props.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runNonce is an intentional re-subscribe trigger — a Recheck starts a NEW server stream, so the effect must tear down and re-attach when the nonce bumps, even though the nonce value isn't read inside.
  useEffect(() => {
    let cancelled = false
    // Reset on each (re-)subscribe so a Recheck starts the log fresh; the new
    // subscription then replays the new run's buffered output.
    setCommand(null)
    setLog("")
    const subscription = client.workflows.onOutput.subscribe(
      { projectId, task },
      {
        onData: (event: WorkflowOutputEvent) => {
          if (cancelled) return
          if (event.kind === "start") setCommand(event.command)
          else if (event.kind === "chunk")
            setLog((prev) => {
              const next = prev + event.text
              return next.length > MAX_LOG_CHARS ? next.slice(next.length - MAX_LOG_CHARS) : next
            })
        },
        // A failed/absent subscription must not blank the window — the report
        // still renders from props (no silent crash).
        onError: () => {},
      },
    )
    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [client, projectId, task, runNonce])

  // Recheck: force a fresh run, then re-subscribe (bump the nonce) once it has
  // started so the activity log + report update live as it re-runs. Both settle
  // paths re-subscribe so a rejected run still detaches the stale subscription.
  const onRecheckClick = () => {
    if (running || rechecking) return
    setRechecking(true)
    const settled = () => {
      setRechecking(false)
      setRunNonce((nonce) => nonce + 1)
    }
    onRecheck().then(settled, settled)
  }

  // Keep the log pinned to the newest output as it streams in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on each log/command change.
  useEffect(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [log, command])

  const isError = errorMessage !== null

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a click-to-dismiss surface; Escape (bound above) is the keyboard equivalent, and focus stays on the dialog's own controls.
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismissal mirrors Escape, which is already handled; a key handler here would duplicate it.
    <div
      data-testid="workflow-result-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${projectName} — ${title}`}
        data-testid="workflow-result-dialog"
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xl"
      >
        <div className="border-border border-b px-4 py-3">
          <h2 className="font-medium text-foreground text-sm">
            {isError ? `${title} failed` : title}
          </h2>
          <p className="truncate text-muted-foreground text-xs">{projectName}</p>
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-4">
          {/* Live agent activity — the "what is happening" view. */}
          <section aria-label="Agent activity" className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Agent activity
              </span>
              {running ? (
                <span className="inline-flex items-center gap-1 text-brand text-xs">
                  <span className="size-1.5 animate-pulse rounded-full bg-brand" aria-hidden />
                  live
                </span>
              ) : null}
            </div>
            <div
              ref={logRef}
              data-testid="workflow-activity-log"
              className="max-h-56 min-h-24 cursor-text select-text overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-accent/40 p-3 font-mono text-[11px] text-foreground/90 leading-relaxed"
            >
              {command ? (
                <div data-testid="workflow-activity-command" className="mb-1 text-muted-foreground">
                  $ {command}
                </div>
              ) : null}
              {log ? (
                log
              ) : (
                <span className="text-muted-foreground">
                  {running ? "Waiting for output…" : "No output was captured for this run."}
                </span>
              )}
            </div>
          </section>

          {/* Report — working state while running, else the markdown result / error. */}
          <section className="flex flex-col gap-2">
            <h3 className="font-medium text-foreground text-sm">{reportHeading}</h3>
            {running ? (
              <p
                data-testid="workflow-result-working"
                className="flex items-center gap-2 text-muted-foreground text-sm"
              >
                <span className="size-1.5 animate-pulse rounded-full bg-brand" aria-hidden />
                Working… the report appears here when the run finishes.
              </p>
            ) : isError ? (
              <p
                data-testid="workflow-result-error"
                className="cursor-text select-text whitespace-pre-wrap text-destructive text-sm leading-relaxed"
              >
                {errorMessage}
              </p>
            ) : result ? (
              <div data-testid="workflow-result-text">
                <Markdown content={result} />
              </div>
            ) : (
              <p
                data-testid="workflow-result-updated"
                className="cursor-text select-text text-foreground text-sm leading-relaxed"
              >
                The run finished but printed no summary text.
              </p>
            )}

            {running || isError ? null : (
              <p data-testid="workflow-result-guidance" className="text-muted-foreground text-xs">
                {guidance}
              </p>
            )}

            {running ? null : (
              <p
                data-testid="workflow-result-last-checked"
                className={cn("text-muted-foreground/80 text-xs")}
              >
                Last checked: {formatRelativeTime(lastCheckedAt)}
              </p>
            )}
          </section>
        </div>

        <div className="flex justify-end gap-2 border-border border-t px-4 py-3">
          <button
            type="button"
            data-testid="workflow-result-recheck"
            onClick={onRecheckClick}
            disabled={running || rechecking}
            className="rounded-md border border-border px-3 py-1.5 font-medium text-foreground text-sm transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {rechecking || running ? "Rechecking…" : "Recheck"}
          </button>
          <button
            type="button"
            data-testid="workflow-result-close"
            onClick={onClose}
            className="rounded-md bg-brand px-3 py-1.5 font-medium text-brand-foreground text-sm transition-colors hover:bg-brand/90"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
