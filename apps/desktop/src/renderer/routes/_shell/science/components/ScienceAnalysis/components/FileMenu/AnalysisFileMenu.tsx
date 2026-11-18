import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { validateEntryName } from "../../../../../../../Editor/components/FileTree/FileTree"
import {
  DeleteConfirmDialog,
  FileTreeContextMenu,
  parentRelPath,
  type TreeEntryRef,
  type TreeMenuState,
} from "../../../../../../../Editor/components/FileTree/FileTreeManage"
import { useTranslate } from "../../../../../../../i18n/language"
import { useMachineScope } from "../../../../../../../machines/machines"
import { useCopyPath } from "../../../../../../../machines/useCopyPath"
import { useTRPC } from "../../../../../../../trpc/react"

/**
 * The right-click menu of an Analysis file: the project file tree's menu (Open,
 * Reveal in Finder, Copy Path, Copy Relative Path, Rename, Duplicate, Delete),
 * acting on the project's main workspace. Open previews the file here. After a
 * rename, duplicate or delete the file list is read again.
 */
export function AnalysisFileMenu({
  projectId,
  menu,
  onClose,
  onOpen,
  onMoved,
}: {
  projectId: string
  menu: TreeMenuState | null
  onClose: () => void
  /** Preview this file. */
  onOpen: (relPath: string) => void
  /** A file was renamed (`to` is its new path) or deleted (`to` is null). */
  onMoved: (from: string, to: string | null) => void
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const workspaceId = useMainWorkspaceId(projectId)
  const settings = useQuery(trpc.settings.get.queryOptions())
  const editor = settings.data?.editor ?? DEFAULT_EDITOR_SETTINGS
  const confirmDelete = editor.confirmFileDelete ?? DEFAULT_EDITOR_SETTINGS.confirmFileDelete
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<TreeEntryRef | null>(null)
  const [renaming, setRenaming] = useState<TreeEntryRef | null>(null)
  const relist = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.science.analysis.listFiles.queryKey() })
  const report = (cause: { message: string }) => setError(cause.message)
  const reveal = useMutation(trpc.files.reveal.mutationOptions({ onError: report }))
  const copyPath = useCopyPath(report)
  const onAnotherMachine = useMachineScope() !== null
  const duplicate = useMutation(
    trpc.files.duplicate.mutationOptions({ onError: report, onSuccess: relist }),
  )
  const updateEditor = useMutation(trpc.settings.updateEditor.mutationOptions({ onError: report }))
  const trash = useMutation(
    trpc.files.trash.mutationOptions({
      onSuccess: (_result, input) => {
        setPendingDelete(null)
        onMoved(input.relPath, null)
        relist()
      },
    }),
  )
  const rename = useMutation(
    trpc.files.rename.mutationOptions({
      onSuccess: (_result, input) => {
        setRenaming(null)
        onMoved(input.relPath, input.newRelPath)
        relist()
      },
    }),
  )
  // Every action needs the workspace; until it is known, the menu says so.
  const withWorkspace = (action: (id: string) => void) => {
    setError(null)
    if (workspaceId === null) setError(t("The project's workspace is still opening; try again."))
    else action(workspaceId)
  }
  const requestDelete = (entry: TreeEntryRef) =>
    withWorkspace((id) => {
      trash.reset()
      if (confirmDelete) setPendingDelete(entry)
      else trash.mutate({ workspaceId: id, relPath: entry.relPath }, { onError: report })
    })

  return (
    <>
      <FileTreeContextMenu
        menu={menu}
        onClose={onClose}
        actions={{
          onOpen: (entry) => onOpen(entry.relPath),
          // Folders are not listed in Analysis menus, so there is nothing to create in.
          onNewFile: () => undefined,
          onNewFolder: () => undefined,
          onReveal: onAnotherMachine
            ? undefined
            : (entry) =>
                withWorkspace((id) => reveal.mutate({ workspaceId: id, relPath: entry.relPath })),
          onCopyPath: (entry, form) =>
            withWorkspace((id) =>
              copyPath.mutate({ workspaceId: id, relPath: entry.relPath, form }),
            ),
          onRename: (entry) => {
            rename.reset()
            setRenaming(entry)
          },
          onDuplicate: (entry) =>
            withWorkspace((id) => duplicate.mutate({ workspaceId: id, relPath: entry.relPath })),
          onDelete: requestDelete,
        }}
      />
      {error ? (
        <div
          role="alert"
          className="fixed right-4 bottom-4 z-50 flex max-w-sm items-start gap-2 rounded-md border border-destructive/40 bg-card px-3 py-2 text-destructive text-xs shadow-lg"
        >
          <span className="cursor-text select-text">{error}</span>
          <button type="button" onClick={() => setError(null)} className="hover:text-foreground">
            {t("Dismiss")}
          </button>
        </div>
      ) : null}
      {pendingDelete ? (
        <DeleteConfirmDialog
          entry={pendingDelete}
          unsavedPaths={[]}
          pending={trash.isPending}
          error={trash.error?.message ?? null}
          onCancel={() => setPendingDelete(null)}
          onConfirm={(dontAskAgain) =>
            withWorkspace((id) => {
              if (dontAskAgain) updateEditor.mutate({ confirmFileDelete: false })
              trash.mutate({ workspaceId: id, relPath: pendingDelete.relPath })
            })
          }
        />
      ) : null}
      {renaming ? (
        <RenameDialog
          entry={renaming}
          pending={rename.isPending}
          serverError={rename.error?.message ?? null}
          onCancel={() => setRenaming(null)}
          onSubmit={(name) =>
            withWorkspace((id) => {
              const parent = parentRelPath(renaming.relPath)
              rename.mutate({
                workspaceId: id,
                relPath: renaming.relPath,
                newRelPath: parent ? `${parent}/${name}` : name,
              })
            })
          }
        />
      ) : null}
    </>
  )
}

/** The project's main workspace id (made if needed), or null while it opens. */
function useMainWorkspaceId(projectId: string): string | null {
  const trpc = useTRPC()
  const ensureMain = useMutation(trpc.workspaces.ensureMain.mutationOptions())
  const ensure = useRef(ensureMain.mutateAsync)
  ensure.current = ensureMain.mutateAsync
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setWorkspaceId(null)
    ensure.current({ projectId }).then(
      (workspace) => {
        if (active) setWorkspaceId(workspace.id)
      },
      // The error shows when an action needs the workspace.
      () => undefined,
    )
    return () => {
      active = false
    }
  }, [projectId])
  return workspaceId
}

/** Ask for a file's new name. Enter renames, Escape cancels. */
function RenameDialog({
  entry,
  pending,
  serverError,
  onCancel,
  onSubmit,
}: {
  entry: TreeEntryRef
  pending: boolean
  serverError: string | null
  onCancel: () => void
  onSubmit: (name: string) => void
}) {
  const t = useTranslate()
  const [name, setName] = useState(entry.name)
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    const trimmed = name.trim()
    if (trimmed === entry.name) {
      onCancel()
      return
    }
    const problem = validateEntryName(trimmed)
    if (problem) setError(t(problem))
    else onSubmit(trimmed)
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Rename")}
        data-testid="analysis-rename-dialog"
        className="w-full max-w-sm rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xl"
      >
        <h2 className="font-medium text-foreground text-sm">{t("Rename")}</h2>
        <p className="mt-1 cursor-text select-text break-all font-mono text-muted-foreground text-xs">
          {entry.relPath}
        </p>
        <input
          data-testid="analysis-rename-input"
          // biome-ignore lint/a11y/noAutofocus: the dialog opens from an explicit Rename and typing the name is the next action.
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit()
            if (event.key === "Escape") onCancel()
          }}
          className="mt-3 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
        />
        {(error ?? serverError) ? (
          <p role="alert" className="mt-2 cursor-text select-text text-destructive text-xs">
            {error ?? serverError}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1.5 text-sm hover:bg-accent"
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            data-testid="analysis-rename-confirm"
            disabled={pending}
            onClick={submit}
            className="rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {t("Rename")}
          </button>
        </div>
      </div>
    </div>
  )
}
