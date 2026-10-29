import {
  ClipboardCopy,
  Copy,
  CopyPlus,
  FilePlus2,
  FileText,
  FolderPlus,
  FolderSearch,
  Pencil,
  Pin,
  Trash2,
} from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTranslate } from "../../../i18n/language"

/** A file tree row an action applies to. */
export interface TreeEntryRef {
  /** Path relative to the workspace working dir, POSIX-separated. */
  relPath: string
  name: string
  kind: "file" | "dir"
}

/** One open editor tab, as the tree needs it for delete and rename. */
export interface EditorTabRef {
  relPath: string
  dirty: boolean
}

/**
 * The host editor's open tabs. Delete closes the tabs of removed paths and
 * rename moves clean tabs to the new path, so no tab is left on a missing file.
 */
export interface FileTreeEditorTabs {
  tabs: readonly EditorTabRef[]
  /** Close one tab without saving (the tree has already confirmed with the user). */
  closeFile: (relPath: string) => void
}

/** Position + target of a row's right-click menu. */
export interface TreeMenuState {
  entry: TreeEntryRef
  x: number
  y: number
}

/** Tabs showing `relPath` itself or, for a folder, any path inside it. */
export function affectedTabs(tabs: readonly EditorTabRef[], relPath: string): EditorTabRef[] {
  return tabs.filter((tab) => tab.relPath === relPath || tab.relPath.startsWith(`${relPath}/`))
}

/** Map a path under `from` to the same place under `to` (used after a rename). */
export function movedPath(path: string, from: string, to: string): string {
  return path === from ? to : `${to}${path.slice(from.length)}`
}

/** The parent folder of a workspace-relative path ("" for the root). */
export function parentRelPath(relPath: string): string {
  const slash = relPath.lastIndexOf("/")
  return slash === -1 ? "" : relPath.slice(0, slash)
}

/** macOS Cmd+Delete (the key labelled delete sends Backspace), with no other modifier. */
export function isDeleteChord(event: React.KeyboardEvent): boolean {
  return (
    event.key === "Backspace" && event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey
  )
}

/** The actions the row menu can run; each closes the menu first. */
export interface TreeMenuActions {
  onOpen: (entry: TreeEntryRef) => void
  onNewFile: (entry: TreeEntryRef) => void
  onNewFolder: (entry: TreeEntryRef) => void
  onReveal: (entry: TreeEntryRef) => void
  onCopyPath: (entry: TreeEntryRef, form: "absolute" | "relative") => void
  onRename: (entry: TreeEntryRef) => void
  onDuplicate: (entry: TreeEntryRef) => void
  onDelete: (entry: TreeEntryRef) => void
  /** Present only when the host can pin a `.md` file as a right-sidebar panel. */
  onPin?: (entry: TreeEntryRef) => void
  /** Present only when the host can make a `.md` file the project's main readme. */
  onSetMain?: (entry: TreeEntryRef) => void
}

interface MenuItem {
  label: string
  testId: string
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }> | null
  run: () => void
  destructive?: boolean
  featureHelp?: string
}

/**
 * The right-click menu for a file or folder row, rendered once at the tree root
 * and positioned at the cursor (kept inside the window). Closes on outside
 * mousedown or Escape; an item click stays inside `rootRef` so it runs before
 * the menu closes.
 */
export function FileTreeContextMenu({
  menu,
  onClose,
  actions,
}: {
  menu: TreeMenuState | null
  onClose: () => void
  actions: TreeMenuActions
}) {
  const t = useTranslate()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("mousedown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("mousedown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [menu, onClose])

  // Shift the menu up/left when the cursor is near the window's bottom/right edge.
  useLayoutEffect(() => {
    if (!menu) {
      setPosition(null)
      return
    }
    const rect = rootRef.current?.getBoundingClientRect()
    const width = rect?.width ?? 0
    const height = rect?.height ?? 0
    setPosition({
      left: Math.max(0, Math.min(menu.x, window.innerWidth - width - 4)),
      top: Math.max(0, Math.min(menu.y, window.innerHeight - height - 4)),
    })
  }, [menu])

  if (!menu) return null
  const { entry } = menu
  const markdown = entry.kind === "file" && entry.name.endsWith(".md")
  const run = (action: () => void) => () => {
    onClose()
    action()
  }
  const copyItems: MenuItem[] = [
    {
      label: t("Reveal in Finder"),
      testId: "file-tree-reveal",
      icon: FolderSearch,
      run: run(() => actions.onReveal(entry)),
    },
    {
      label: t("Copy Path"),
      testId: "file-tree-copy-path",
      icon: Copy,
      run: run(() => actions.onCopyPath(entry, "absolute")),
    },
    {
      label: t("Copy Relative Path"),
      testId: "file-tree-copy-relative-path",
      icon: ClipboardCopy,
      run: run(() => actions.onCopyPath(entry, "relative")),
    },
  ]
  const deleteItem: MenuItem = {
    label: t("Delete"),
    testId: "file-tree-delete",
    icon: Trash2,
    destructive: true,
    run: run(() => actions.onDelete(entry)),
  }
  const renameItem: MenuItem = {
    label: t("Rename"),
    testId: "file-tree-rename",
    icon: Pencil,
    run: run(() => actions.onRename(entry)),
  }
  const groups: MenuItem[][] =
    entry.kind === "dir"
      ? [
          [
            {
              label: t("New File"),
              testId: "file-tree-new-file",
              icon: FilePlus2,
              run: run(() => actions.onNewFile(entry)),
            },
            {
              label: t("New Folder"),
              testId: "file-tree-new-folder",
              icon: FolderPlus,
              run: run(() => actions.onNewFolder(entry)),
            },
          ],
          copyItems,
          [renameItem, deleteItem],
        ]
      : [
          [
            {
              label: t("Open"),
              testId: "file-tree-open",
              icon: FileText,
              run: run(() => actions.onOpen(entry)),
            },
            ...(markdown && actions.onPin
              ? [
                  {
                    label: t("Pin as panel"),
                    testId: "file-tree-pin",
                    icon: Pin,
                    featureHelp: t(
                      "Pin this Markdown file as a persistent panel in the project's right sidebar",
                    ),
                    run: run(() => actions.onPin?.(entry)),
                  },
                ]
              : []),
            ...(markdown && actions.onSetMain
              ? [
                  {
                    label: t("Set as main readme"),
                    testId: "file-tree-set-main",
                    icon: null,
                    run: run(() => actions.onSetMain?.(entry)),
                  },
                ]
              : []),
          ],
          copyItems,
          [
            renameItem,
            {
              label: t("Duplicate"),
              testId: "file-tree-duplicate",
              icon: CopyPlus,
              run: run(() => actions.onDuplicate(entry)),
            },
            deleteItem,
          ],
        ]

  return (
    <div
      ref={rootRef}
      data-testid="file-tree-context-menu"
      data-rel-path={entry.relPath}
      role="menu"
      aria-label={entry.name}
      className="fixed z-50 w-56 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
      style={{
        left: position?.left ?? menu.x,
        top: position?.top ?? menu.y,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {groups.map((group, index) => (
        <div
          key={group[0]?.testId}
          className={index > 0 ? "mt-1 border-border border-t pt-1" : undefined}
        >
          {group.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.testId}
                type="button"
                role="menuitem"
                data-testid={item.testId}
                data-rel-path={entry.relPath}
                data-feature-label={item.featureHelp ? item.label : undefined}
                data-feature-help={item.featureHelp}
                onClick={item.run}
                className={
                  item.destructive
                    ? "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-destructive text-sm transition-colors hover:bg-destructive/10"
                    : "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                }
              >
                {Icon ? (
                  <Icon className="size-4 shrink-0" aria-hidden />
                ) : (
                  <span className="size-4 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 truncate">{item.label}</span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/**
 * Confirmation before moving a file or folder to the Trash. Names the item and
 * lists open tabs whose unsaved changes would be lost. "Move to Trash" takes
 * focus so Enter confirms, matching the ⌘⌫ keyboard flow; Escape cancels.
 * "Don't ask again" is offered only when no unsaved work is at stake; its value
 * is passed to `onConfirm`.
 */
export function DeleteConfirmDialog({
  entry,
  unsavedPaths,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  entry: TreeEntryRef
  unsavedPaths: string[]
  pending: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}) {
  const t = useTranslate()
  const [dontAskAgain, setDontAskAgain] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onCancel])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a click-to-dismiss surface; Escape and the Cancel button provide keyboard-accessible dismissal.
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismissal mirrors Escape, which is already handled by the dialog.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="file-tree-delete-title"
        data-testid="file-tree-delete-dialog"
        data-rel-path={entry.relPath}
        className="w-full max-w-sm rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xl"
      >
        <h2 id="file-tree-delete-title" className="font-medium text-foreground text-sm">
          {entry.kind === "dir" ? t("Delete folder?") : t("Delete file?")}
        </h2>
        <p className="mt-2 cursor-text select-text break-all font-mono text-foreground text-xs">
          {entry.relPath}
        </p>
        <p className="mt-2 text-muted-foreground text-xs">
          {entry.kind === "dir"
            ? t("The folder and everything in it will be moved to the Trash.")
            : t("It will be moved to the Trash.")}
        </p>
        {unsavedPaths.length > 0 ? (
          <div className="mt-2 text-destructive text-xs">
            <p>{t("These open tabs have unsaved changes that will be lost:")}</p>
            <ul className="mt-1 list-disc pl-4">
              {unsavedPaths.map((path) => (
                <li key={path} className="cursor-text select-text break-all font-mono">
                  {path}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {unsavedPaths.length === 0 ? (
          <label className="mt-3 flex items-center gap-2 text-muted-foreground text-xs">
            <input
              type="checkbox"
              data-testid="file-tree-delete-dont-ask"
              checked={dontAskAgain}
              onChange={(event) => setDontAskAgain(event.target.checked)}
            />
            {t("Don't ask again")}
          </label>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="mt-2 cursor-text select-text text-destructive text-xs leading-snug"
          >
            {error}
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
            data-testid="file-tree-delete-confirm"
            // biome-ignore lint/a11y/noAutofocus: the dialog opens from an explicit delete request and confirming is the next expected action.
            autoFocus
            disabled={pending}
            onClick={() => onConfirm(dontAskAgain)}
            className="rounded bg-destructive px-3 py-1.5 text-destructive-foreground text-sm hover:bg-destructive/90 disabled:opacity-50"
          >
            {t("Move to Trash")}
          </button>
        </div>
      </div>
    </div>
  )
}
