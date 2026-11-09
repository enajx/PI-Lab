import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, FolderOpen, X } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { useTranslate } from "../../../../../i18n/language"
import { useTRPC } from "../../../../../trpc/react"
import { PaperDialog } from "./PaperSyncBar"

/** Whether Sync is on for a project folder that is not an Overleaf clone (see `paper.link`). */
export type RootChoice = "sync" | "no-sync"

/** A folder the user chose as the paper folder, after the folder checks. */
export interface ChosenPaperFolder {
  dir: string
  /** The user's answer in the project-folder pop-up, or null when it was not asked. */
  rootChoice: RootChoice | null
  /** The folder as shown to the user (from `paper.checkFolder`). */
  displayDir: string
}

/** A project folder that is not an Overleaf clone, waiting for the user's choice. */
interface RootPrompt {
  dir: string
  displayDir: string
  /** Its `origin` URL without credentials, or null when it has no remote. */
  remoteUrl: string | null
}

/** The label for a paper folder's `displayDir`: "Project folder" for ".", else the path itself. */
export function paperFolderLabel(displayDir: string, t: (english: string) => string): string {
  return displayDir === "." ? t("Project folder") : displayDir
}

/**
 * The folder picker with the paper folder checks, shared by the setup page,
 * the editor footer and the Edit project dialog. `choose` asks for a folder
 * and checks it (`paper.checkFolder`). The project folder, when it is not an
 * Overleaf clone, first shows the pop-up (`dialog`, which the caller renders)
 * with its three options; "Choose another folder" opens the picker again.
 * The chosen folder goes to `onChosen`, and errors go to `onError`.
 */
export function usePaperFolderPicker(
  projectId: string,
  onChosen: (chosen: ChosenPaperFolder) => void,
  onError: (cause: { message: string }) => void,
): { choose: () => void; busy: boolean; dialog: ReactNode } {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [rootPrompt, setRootPrompt] = useState<RootPrompt | null>(null)
  const [checking, setChecking] = useState(false)
  const pickDirectory = useMutation(trpc.system.pickDirectory.mutationOptions({ onError }))

  const choose = (): void => {
    pickDirectory.mutate(undefined, {
      onSuccess: (dir) => {
        if (!dir) return
        setChecking(true)
        queryClient
          .fetchQuery(trpc.paper.checkFolder.queryOptions({ projectId, dir }))
          .then((check) => {
            if (check.projectFolder && !check.overleaf) {
              setRootPrompt({ dir, displayDir: check.displayDir, remoteUrl: check.remoteUrl })
            } else onChosen({ dir, rootChoice: null, displayDir: check.displayDir })
          }, onError)
          .finally(() => setChecking(false))
      },
    })
  }

  const dialog = rootPrompt ? (
    <RootFolderDialog
      remoteUrl={rootPrompt.remoteUrl}
      onChoice={(choice) => {
        setRootPrompt(null)
        if (choice === "other") choose()
        else if (choice !== "cancel") {
          onChosen({ dir: rootPrompt.dir, rootChoice: choice, displayDir: rootPrompt.displayDir })
        }
      }}
    />
  ) : null
  return { choose, busy: pickDirectory.isPending || checking, dialog }
}

/** What the user chose in {@link RootFolderDialog}. */
type RootDialogChoice = "no-sync" | "sync" | "other" | "cancel"

/**
 * Asked when the chosen folder is the project folder and it is not an Overleaf
 * clone: Sync would commit and push the whole project to its remote. With no
 * remote, "Use it with Sync" is not offered.
 */
function RootFolderDialog({
  remoteUrl,
  onChoice,
}: {
  remoteUrl: string | null
  onChoice: (choice: RootDialogChoice) => void
}) {
  const t = useTranslate()
  const buttonClass = "rounded border border-border px-3 py-1.5 text-sm hover:bg-accent"
  return (
    <PaperDialog
      testId="paper-root-dialog"
      title={t("Use the project folder as the paper folder?")}
      onClose={() => onChoice("cancel")}
    >
      <p className="mt-2 cursor-text select-text text-muted-foreground text-xs">
        {remoteUrl
          ? `${t("This folder is not an Overleaf clone. Sync would commit and push the whole project to:")} ${remoteUrl}`
          : t(
              "This folder is not an Overleaf clone, and it has no Git remote, so Sync cannot run.",
            )}
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          data-testid="paper-root-no-sync"
          className={buttonClass}
          onClick={() => onChoice("no-sync")}
        >
          {t("Use it, edit and build only (no Sync)")}
        </button>
        {remoteUrl ? (
          <button
            type="button"
            data-testid="paper-root-sync"
            className={buttonClass}
            onClick={() => onChoice("sync")}
          >
            {t("Use it with Sync")}
          </button>
        ) : null}
        <button
          type="button"
          data-testid="paper-root-other"
          className={buttonClass}
          onClick={() => onChoice("other")}
        >
          {t("Choose another folder")}
        </button>
      </div>
    </PaperDialog>
  )
}

/**
 * The LaTeX Editor footer's "Paper folder" item: shows the paper folder and
 * opens a small menu to choose another one (same checks as the setup page) or
 * to clear it (forgets the folder, keeps every file; the page then shows the
 * setup). Errors are shown next to the item.
 */
export function PaperFolderStatusItem({
  projectId,
  dir,
  displayDir,
}: {
  projectId: string
  /** The paper folder's full path, shown as the tooltip. */
  dir: string
  /** The folder as shown to the user (from `paper.get`). */
  displayDir: string
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const onError = (cause: { message: string }): void => setError(cause.message)
  const changed = (): void => {
    void queryClient.invalidateQueries({ queryKey: trpc.paper.get.queryKey({ projectId }) })
  }
  const link = useMutation(trpc.paper.link.mutationOptions({ onSuccess: changed, onError }))
  const unlink = useMutation(trpc.paper.unlink.mutationOptions({ onSuccess: changed, onError }))
  const picker = usePaperFolderPicker(
    projectId,
    (chosen) => link.mutate({ projectId, dir: chosen.dir, rootChoice: chosen.rootChoice }),
    onError,
  )

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", dismiss)
    document.addEventListener("keydown", dismissOnEscape)
    return () => {
      document.removeEventListener("mousedown", dismiss)
      document.removeEventListener("keydown", dismissOnEscape)
    }
  }, [open])

  const busy = picker.busy || link.isPending || unlink.isPending
  const itemClass =
    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-xs hover:bg-accent"
  return (
    <div ref={rootRef} className="relative flex min-w-0 items-center gap-2">
      {error ? (
        <span role="alert" title={error} className="min-w-0 select-text truncate text-destructive">
          {error}
        </span>
      ) : null}
      <button
        type="button"
        data-testid="editor-paper-folder"
        title={`${t("Paper folder")}: ${dir}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen(!open)}
        className="flex shrink-0 items-center gap-0.5 rounded px-1 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {paperFolderLabel(displayDir, t)}
        <ChevronDown className="size-3" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={t("Paper folder")}
          className="absolute end-0 bottom-full z-30 mb-1 w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <div className="px-2 py-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
            {t("Paper folder")}
          </div>
          <button
            type="button"
            role="menuitem"
            data-testid="paper-folder-choose"
            onClick={() => {
              setOpen(false)
              setError(null)
              picker.choose()
            }}
            className={itemClass}
          >
            <FolderOpen className="size-3 shrink-0" aria-hidden />
            {t("Choose paper folder…")}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="paper-folder-clear"
            title={t("Forget this folder. No files are deleted.")}
            onClick={() => {
              setOpen(false)
              setError(null)
              unlink.mutate({ projectId })
            }}
            className={itemClass}
          >
            <X className="size-3 shrink-0" aria-hidden />
            {t("Clear paper folder")}
          </button>
        </div>
      ) : null}
      {picker.dialog}
    </div>
  )
}
