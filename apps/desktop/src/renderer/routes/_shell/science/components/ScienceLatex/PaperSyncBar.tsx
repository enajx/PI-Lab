import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, RefreshCw } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { elapsedSince } from "../../../../../components/elapsed"
import { usePopupDismiss } from "../../../../../components/usePopupDismiss"
import { useTranslate } from "../../../../../i18n/language"
import { useTRPC } from "../../../../../trpc/react"
import { AgentMergeReview } from "./AgentMergeReview"

/** What a Sync call returned, as defined by the main-process `paper.sync` procedure. */
type SyncResult =
  | { state: "needs-commit"; changedFiles: string[] }
  | { state: "conflict"; files: string[] }
  | { state: "synced"; lastSyncAt: number }
  | { state: "no-remote" }

/** The dialog the Sync controls are showing, if any. */
type Prompt =
  | { kind: "commit"; files: string[] }
  | { kind: "conflict"; files: string[] }
  | { kind: "agent"; files: string[] }
  | null

interface PaperSyncBarProps {
  projectId: string
  /** The paper folder's workspace, used to read files for the agent-merge review. */
  workspaceId: string
  /** The page top bar's element that gets the Sync button, or null before it mounts or when the user removed Sync from the top bar. */
  syncSlot: HTMLElement | null
  /** The editor footer's element that gets the last sync time, Sync messages and the output folder item, or null before it mounts. */
  footerSlot: HTMLElement | null
  lastSyncAt: number | null
  /** False when the paper folder has no Git remote; Sync is then disabled. */
  hasRemote: boolean
  /** False when the paper is linked for editing and building only; the Sync button is then hidden. */
  syncEnabled: boolean
  /** The `confirmOverleafCommit` editor setting. */
  confirmCommit: boolean
  /** This paper's own build output folder, or null when it uses the global default. */
  outputDir: string | null
  /** The global default build output folder (Settings > LaTeX). */
  defaultOutputDir: string
  /** Open the given paper files in the editor pane ("Open in editor"). */
  onOpenFiles: (files: string[]) => void
  /** Save every open paper file with unsaved edits; returns the files that could not be saved. */
  saveOpenFiles: () => Promise<string[]>
}

/** How often the footer's last sync time is refreshed (ms). */
const LAST_SYNC_REFRESH_MS = 30_000

/**
 * The last Overleaf sync as a short phrase: "Synced just now" (under a minute),
 * "Synced 5 minutes ago", "Synced 1 hour ago", "Synced 2 days ago", or
 * "Not synced yet" when the paper was never synced.
 */
export function formatLastSync(lastSyncAt: number | null, now: number): string {
  if (lastSyncAt === null) return "Not synced yet"
  const elapsed = elapsedSince(lastSyncAt, now)
  if (elapsed.unit === "now") return "Synced just now"
  return `Synced ${elapsed.count} ${elapsed.unit}${elapsed.count === 1 ? "" : "s"} ago`
}

/**
 * The LaTeX Editor Sync controls. The Sync button is placed in the page top bar
 * (`syncSlot`), or a short note there when Sync is off for the paper. The
 * editor footer (`footerSlot`) gets the last sync time, the Sync messages and
 * errors, and the output folder item. Also shows the dialogs Sync can lead to:
 * the commit question for edits not yet sent, the conflict choices, and the
 * review of an agent merge.
 */
export function PaperSyncBar({
  projectId,
  workspaceId,
  syncSlot,
  footerSlot,
  lastSyncAt,
  hasRemote,
  syncEnabled,
  confirmCommit,
  outputDir,
  defaultOutputDir,
  onOpenFiles,
  saveOpenFiles,
}: PaperSyncBarProps) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [prompt, setPrompt] = useState<Prompt>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const now = useNow(LAST_SYNC_REFRESH_MS)

  /** Show the next step for a Sync or resolve result. */
  const handle = (result: SyncResult): void => {
    if (result.state === "needs-commit") setPrompt({ kind: "commit", files: result.changedFiles })
    else if (result.state === "conflict") setPrompt({ kind: "conflict", files: result.files })
    else if (result.state === "no-remote") {
      setPrompt(null)
      setNotice(t("This paper folder has no Git remote to sync with."))
    } else {
      setPrompt(null)
      setNotice(null)
      // A pull can add sections.
      void queryClient.invalidateQueries({ queryKey: trpc.paper.get.queryKey({ projectId }) })
      void queryClient.invalidateQueries({ queryKey: trpc.paper.outline.queryKey({ projectId }) })
    }
  }
  const onError = (cause: { message: string }): void =>
    setError(
      cause.message === "overleaf-token-required"
        ? t("Save your Overleaf Git token in Settings > LaTeX, then Sync again.")
        : cause.message,
    )
  const sync = useMutation(
    trpc.paper.sync.mutationOptions({ onSuccess: (result) => handle(result), onError }),
  )
  const resolve = useMutation(
    trpc.paper.resolve.mutationOptions({ onSuccess: (result) => handle(result), onError }),
  )
  const updateEditor = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
      },
      onError,
    }),
  )
  const busy = sync.isPending || resolve.isPending

  /** Save open edits so they are sent too, then sync; a failed save stops the sync. */
  const startSync = async (commit: boolean): Promise<void> => {
    setError(null)
    const unsaved = await saveOpenFiles()
    if (unsaved.length > 0) {
      setError(`${t("Could not save, so Sync did not run:")} ${unsaved.join(", ")}`)
      return
    }
    sync.mutate({ projectId, commit })
  }

  return (
    <>
      {syncSlot && !syncEnabled
        ? createPortal(
            <span data-testid="paper-sync-off" className="text-muted-foreground text-xs">
              {t("Sync is off for this paper")}
            </span>,
            syncSlot,
          )
        : null}
      {syncSlot && syncEnabled
        ? createPortal(
            <button
              type="button"
              data-testid="paper-sync"
              disabled={!hasRemote || busy}
              title={hasRemote ? t("Pull from and push to Overleaf") : t("No Git remote")}
              data-feature-label={t("Sync")}
              onClick={() => void startSync(!confirmCommit)}
              className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs hover:bg-accent disabled:opacity-50"
            >
              <RefreshCw className={busy ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
              {t("Sync")}
            </button>,
            syncSlot,
          )
        : null}
      {footerSlot
        ? createPortal(
            <>
              {notice ? (
                <span
                  data-testid="paper-sync-notice"
                  title={notice}
                  className="min-w-0 max-w-96 select-text truncate"
                >
                  {notice}
                </span>
              ) : null}
              {error ? (
                <span
                  role="alert"
                  data-testid="paper-sync-error"
                  title={error}
                  className="min-w-0 max-w-96 cursor-text select-text truncate text-destructive"
                >
                  {error}
                </span>
              ) : null}
              {syncEnabled ? (
                <span
                  data-testid="paper-last-sync"
                  title={lastSyncAt === null ? undefined : new Date(lastSyncAt).toLocaleString()}
                  className="shrink-0"
                >
                  {formatLastSync(lastSyncAt, now)}
                </span>
              ) : null}
              <OutputFolderItem
                projectId={projectId}
                outputDir={outputDir}
                defaultOutputDir={defaultOutputDir}
              />
            </>,
            footerSlot,
          )
        : null}
      {prompt?.kind === "commit" ? (
        <CommitDialog
          files={prompt.files}
          pending={busy}
          error={error}
          onCancel={() => setPrompt(null)}
          onConfirm={(dontAskAgain) => {
            if (dontAskAgain) updateEditor.mutate({ confirmOverleafCommit: false })
            void startSync(true)
          }}
        />
      ) : null}
      {prompt?.kind === "conflict" ? (
        <ConflictDialog
          files={prompt.files}
          pending={busy}
          error={error}
          onChoice={(choice) => {
            setError(null)
            if (choice === "mine" || choice === "overleaf") resolve.mutate({ projectId, choice })
            else if (choice === "agent") setPrompt({ kind: "agent", files: prompt.files })
            else if (choice === "editor") {
              setPrompt(null)
              onOpenFiles(prompt.files)
            } else setPrompt(null)
          }}
        />
      ) : null}
      {prompt?.kind === "agent" ? (
        <AgentMergeReview
          projectId={projectId}
          workspaceId={workspaceId}
          pending={busy}
          error={error}
          onAccept={() => void startSync(true)}
          onReject={() => resolve.mutate({ projectId, choice: "restore-conflicts" })}
        />
      ) : null}
    </>
  )
}

/** The current time in ms, updated every `intervalMs`. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

/**
 * The footer's "Output: <folder>" item. It opens a small popover with this
 * paper's build output folder field (empty uses the global default, shown as
 * the placeholder): Enter applies and closes it, Escape or a click outside
 * closes it. A rejected value is shown in the popover; while it is closed, the
 * item turns red with the error as its tooltip, so the error stays visible.
 */
function OutputFolderItem({
  projectId,
  outputDir,
  defaultOutputDir,
}: {
  projectId: string
  outputDir: string | null
  defaultOutputDir: string
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  // The typed output folder, or null while it shows the saved value.
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const setOutputDir = useMutation(
    trpc.paper.setOutputDir.mutationOptions({
      onSuccess: () => {
        setDraft(null)
        setOpen(false)
        void queryClient.invalidateQueries({ queryKey: trpc.paper.get.queryKey({ projectId }) })
      },
      onError: (cause) => setError(cause.message),
    }),
  )

  usePopupDismiss(open, [rootRef], () => setOpen(false))

  return (
    <div ref={rootRef} className="relative flex shrink-0 items-center">
      <button
        type="button"
        data-testid="paper-output-folder"
        title={error ?? t("Build output folder for this paper")}
        data-feature-label={t("Output folder")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={
          error
            ? "flex items-center gap-0.5 rounded px-1 text-destructive transition-colors hover:bg-accent"
            : "flex items-center gap-0.5 rounded px-1 transition-colors hover:bg-accent hover:text-foreground"
        }
      >
        {`${t("Output:")} ${outputDir ?? defaultOutputDir}`}
        <ChevronDown className="size-3" aria-hidden />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t("Output folder")}
          data-testid="paper-output-popover"
          className="absolute end-0 bottom-full z-30 mb-1 w-72 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg"
        >
          <label className="flex flex-col gap-1 text-muted-foreground text-xs">
            {t("Output folder")}
            <input
              data-testid="paper-output-dir"
              // biome-ignore lint/a11y/noAutofocus: the popover opens to edit this one field.
              autoFocus
              value={draft ?? outputDir ?? ""}
              placeholder={defaultOutputDir}
              disabled={setOutputDir.isPending}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return
                if (draft === null) {
                  setOpen(false)
                  return
                }
                setError(null)
                setOutputDir.mutate({ projectId, outputDir: draft })
              }}
              className="h-7 rounded border border-border bg-background px-1.5 text-foreground"
            />
          </label>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t(
              "Relative to the main .tex file's folder (. for next to it). Leave empty to use the default from Settings > LaTeX. Press Enter to apply.",
            )}
          </p>
          {error ? (
            <p role="alert" className="mt-1 cursor-text select-text text-destructive text-xs">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** A centred modal over a dimmed backdrop; Escape calls `onClose`. */
export function PaperDialog({
  testId,
  title,
  onClose,
  children,
}: {
  testId: string
  title: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-border bg-card p-4 text-card-foreground text-sm shadow-xl"
      >
        <h2 className="font-medium text-foreground text-sm">{title}</h2>
        {children}
      </div>
    </div>
  )
}

/** An error line inside a dialog, so it is not hidden behind the backdrop. */
export function DialogError({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <p role="alert" className="mt-2 cursor-text select-text text-destructive text-xs">
      {error}
    </p>
  )
}

/** A list of paper-relative file paths. */
function FileList({ files }: { files: string[] }) {
  return (
    <ul className="mt-2 max-h-40 list-disc overflow-y-auto pl-4">
      {files.map((file) => (
        <li key={file} className="cursor-text select-text break-all font-mono text-xs">
          {file}
        </li>
      ))}
    </ul>
  )
}

const buttonClass = "rounded border border-border px-3 py-1.5 text-sm hover:bg-accent"
const primaryClass =
  "rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"

/** Ask before committing edits not yet sent, with "Don't ask again". */
function CommitDialog({
  files,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  files: string[]
  pending: boolean
  /** A Sync failure, shown here because the dialog covers the footer. */
  error: string | null
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}) {
  const t = useTranslate()
  const [dontAskAgain, setDontAskAgain] = useState(false)
  return (
    <PaperDialog
      testId="paper-commit-dialog"
      title={t("Commit edits before syncing?")}
      onClose={onCancel}
    >
      <p className="mt-2 text-muted-foreground text-xs">
        {t("These files have edits not yet sent to Overleaf. They will be committed and pushed.")}
      </p>
      <FileList files={files} />
      <label className="mt-3 flex items-center gap-2 text-muted-foreground text-xs">
        <input
          type="checkbox"
          data-testid="paper-commit-dont-ask"
          checked={dontAskAgain}
          onChange={(event) => setDontAskAgain(event.target.checked)}
        />
        {t("Don't ask again")}
      </label>
      <DialogError error={error} />
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={buttonClass} onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button
          type="button"
          data-testid="paper-commit-confirm"
          disabled={pending}
          className={primaryClass}
          onClick={() => onConfirm(dontAskAgain)}
        >
          {t("Commit and sync")}
        </button>
      </div>
    </PaperDialog>
  )
}

type ConflictChoice = "mine" | "overleaf" | "agent" | "editor" | "cancel"

/** Show the files in conflict with Overleaf and the ways to resolve them. */
function ConflictDialog({
  files,
  pending,
  error,
  onChoice,
}: {
  files: string[]
  pending: boolean
  error: string | null
  onChoice: (choice: ConflictChoice) => void
}) {
  const t = useTranslate()
  const choices: Array<{ choice: ConflictChoice; label: string }> = [
    { choice: "mine", label: t("Keep my version") },
    { choice: "overleaf", label: t("Keep Overleaf version") },
    { choice: "agent", label: t("Ask agent to merge") },
    { choice: "editor", label: t("Open in editor") },
  ]
  return (
    <PaperDialog
      testId="paper-conflict-dialog"
      title={t("Conflict with changes made on Overleaf")}
      onClose={() => onChoice("cancel")}
    >
      <p className="mt-2 text-muted-foreground text-xs">
        {t("These files were changed both here and on Overleaf:")}
      </p>
      <FileList files={files} />
      <DialogError error={error} />
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {choices.map(({ choice, label }) => (
          <button
            key={choice}
            type="button"
            data-testid={`paper-conflict-${choice}`}
            disabled={pending}
            className={buttonClass}
            onClick={() => onChoice(choice)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          data-testid="paper-conflict-cancel"
          title={t("Leave the conflict to solve it manually")}
          data-feature-label={t("Cancel")}
          className={buttonClass}
          onClick={() => onChoice("cancel")}
        >
          {t("Cancel")}
        </button>
      </div>
    </PaperDialog>
  )
}
