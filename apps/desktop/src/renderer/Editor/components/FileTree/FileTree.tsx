import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowDownAZ,
  ArrowUpAZ,
  ChevronDown,
  ChevronRight,
  Clock3,
  Eye,
  FilePlus2,
  FolderPlus,
  ListFilter,
  X,
} from "lucide-react"
import { createContext, useCallback, useContext, useState } from "react"
import { useTranslate } from "../../../i18n/language"
import { type FileTreeSort, useFileTreeSort } from "../../../preferences/preferences"
import { useTRPC } from "../../../trpc/react"
import type { FileTreeEntry } from "../../../trpc/types"
import { FILE_DRAG_TYPE } from "../../fileDrag"
import { HOLDS_FOCUS_ON_OPEN_ATTR } from "../../focusOnOpen"
import {
  affectedTabs,
  DeleteConfirmDialog,
  FileTreeContextMenu,
  type FileTreeEditorTabs,
  isDeleteChord,
  movedPath,
  parentRelPath,
  type TreeEntryRef,
  type TreeMenuState,
} from "./FileTreeManage"
import { fileIconUrl, folderIconUrl } from "./fileIcons"

export type { FileTreeEditorTabs } from "./FileTreeManage"

/** In-progress inline rename of one row. */
interface RenameDraft {
  entry: TreeEntryRef
  value: string
  error: string | null
  pending: boolean
}

/**
 * Row-level state and handlers shared by every tree level through context, so
 * the right-click menu, ⌘⌫ delete, inline rename, and the hidden-files filter
 * don't have to be threaded through each `TreeLevel`/`TreeNode` prop list.
 */
interface TreeRowActions {
  showHiddenFiles: boolean
  /** The tree's single selection; only this row is highlighted. */
  selection: TreeSelection
  /** Row whose right-click menu is open; it keeps its highlight while the pointer is in the menu. */
  menuRelPath: string | null
  /** Select a row (click, right-click, or keyboard focus); selecting one row deselects any other. */
  onSelect: (selection: TreeSelection) => void
  /** Left-click on a file row: select and open it. */
  onFileClick: (relPath: string) => void
  onContextMenu: (entry: TreeEntryRef, event: React.MouseEvent) => void
  onDeleteRequest: (entry: TreeEntryRef) => void
  rename: RenameDraft | null
  onRenameChange: (value: string) => void
  onRenameSubmit: () => void
  onRenameCancel: () => void
}

const TreeRowActionsContext = createContext<TreeRowActions | null>(null)

function useTreeRowActions(): TreeRowActions {
  const actions = useContext(TreeRowActionsContext)
  if (!actions) throw new Error("File tree rows must render inside FileTree")
  return actions
}

interface FileTreeProps {
  workspaceId: string
  /** Open a file in the editor (called with its working-dir-relative path). */
  onOpenFile: (relPath: string) => void
  /** The file currently focused in the editor, if any. */
  activeRelPath?: string | null
  /** Pin a `.md` file as a right-sidebar panel (enables the row's right-click menu). */
  onPinFile?: (relPath: string) => void
  /** Make a Markdown file the project's main readme. */
  onSetMainFile?: (relPath: string) => void
  /**
   * The host editor's open tabs: delete closes the tabs of removed paths and
   * rename moves them. Omitted only where no editor tabs exist.
   */
  editorTabs?: FileTreeEditorTabs
}

/**
 * The one selected row: a folder ("" is the project root, which highlights no row)
 * or a file. New File/New Folder target the selected folder, or the selected file's folder.
 */
interface TreeSelection {
  kind: "file" | "dir"
  relPath: string
}

const ROOT_SELECTION: TreeSelection = { kind: "dir", relPath: "" }

const isSelected = (selection: TreeSelection, kind: TreeSelection["kind"], relPath: string) =>
  selection.kind === kind && selection.relPath === relPath

interface CreateDraft {
  kind: "file" | "folder"
  parentRelPath: string
}

/**
 * Lazy workspace file tree. The root level is listed via
 * `files.tree` with an empty path; each directory expands on click, fetching its
 * own children on demand so a large repo never walks the whole tree up front.
 * Files open into the editor on click.
 *
 * One row is selected and highlighted at a time. A click, a right-click (which
 * does not open a file), or keyboard focus selects a row, and the selection
 * follows the editor's active file when it changes. Clicking a file keeps keyboard
 * focus on its row (the editor does not take it), so ⌘⌫ right after the click
 * reaches the row.
 *
 * Right-click a row for file actions (open, reveal, copy path, rename, duplicate,
 * delete; new file/folder on folders); the row stays highlighted while its menu
 * is open. ⌘⌫ on a focused row asks to delete it. Delete moves the entry to the OS Trash through
 * `files.trash` after a confirmation, unless the editor setting
 * `confirmFileDelete` is off and no affected tab has unsaved changes. Entries
 * whose name starts with "." are hidden when the editor setting
 * `showHiddenFiles` is off.
 *
 * Scrolling is a native bounded `min-h-0 flex-1 overflow-y-auto` column
 * — no Radix ScrollArea.
 */
export function FileTree({
  workspaceId,
  onOpenFile,
  activeRelPath,
  onPinFile,
  onSetMainFile,
  editorTabs,
}: FileTreeProps) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  // Until settings load, or for a partial settings payload, hidden files use the default (shown).
  const editorSettings = settingsQuery.data?.editor ?? DEFAULT_EDITOR_SETTINGS
  const showHiddenFiles = editorSettings.showHiddenFiles ?? DEFAULT_EDITOR_SETTINGS.showHiddenFiles
  const confirmFileDelete =
    editorSettings.confirmFileDelete ?? DEFAULT_EDITOR_SETTINGS.confirmFileDelete
  const [menu, setMenu] = useState<TreeMenuState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<TreeEntryRef | null>(null)
  const [rename, setRename] = useState<RenameDraft | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [selection, setSelection] = useState<TreeSelection>(() =>
    activeRelPath ? { kind: "file", relPath: activeRelPath } : ROOT_SELECTION,
  )
  // The selection follows the editor's active file when it changes (switching tabs, opening a file).
  const [seenActiveRelPath, setSeenActiveRelPath] = useState(activeRelPath)
  if (seenActiveRelPath !== activeRelPath) {
    setSeenActiveRelPath(activeRelPath)
    if (activeRelPath) setSelection({ kind: "file", relPath: activeRelPath })
  }
  // New files and folders go into the selected folder, or the selected file's folder.
  const targetDir = selection.kind === "dir" ? selection.relPath : parentRelPath(selection.relPath)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set())
  const [draft, setDraft] = useState<CreateDraft | null>(null)
  const [draftName, setDraftName] = useState("")
  const [validationError, setValidationError] = useState<string | null>(null)
  const [sort, setSort] = useFileTreeSort()
  const nextSort = () => {
    const index = FILE_TREE_SORT_CYCLE.indexOf(sort)
    const next = FILE_TREE_SORT_CYCLE[(index + 1) % FILE_TREE_SORT_CYCLE.length]
    if (next) setSort(next)
  }

  const invalidateTree = () =>
    queryClient.invalidateQueries({ queryKey: trpc.files.tree.queryKey() })
  const finishDraft = () => {
    setDraft(null)
    setDraftName("")
    setValidationError(null)
    void invalidateTree()
  }
  const createFile = useMutation(
    trpc.files.createFile.mutationOptions({
      onSuccess: (created) => {
        finishDraft()
        onOpenFile(created.relPath)
      },
    }),
  )
  const createFolder = useMutation(
    trpc.files.createFolder.mutationOptions({
      onSuccess: (created) => {
        finishDraft()
        setSelection({ kind: "dir", relPath: created.relPath })
        setExpandedDirs((current) => new Set(current).add(created.relPath))
      },
    }),
  )

  const tabs = editorTabs?.tabs ?? []
  const reportActionError = (error: { message: string }) => setActionError(error.message)
  const reveal = useMutation(trpc.files.reveal.mutationOptions({ onError: reportActionError }))
  const copyPath = useMutation(trpc.files.copyPath.mutationOptions({ onError: reportActionError }))
  const duplicate = useMutation(
    trpc.files.duplicate.mutationOptions({
      onError: reportActionError,
      onSuccess: () => void invalidateTree(),
    }),
  )
  const updateEditor = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      onError: reportActionError,
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() }),
    }),
  )
  const trash = useMutation(
    trpc.files.trash.mutationOptions({
      onSuccess: (_result, input) => {
        for (const tab of affectedTabs(tabs, input.relPath)) editorTabs?.closeFile(tab.relPath)
        const inside = (path: string) =>
          path === input.relPath || path.startsWith(`${input.relPath}/`)
        if (inside(selection.relPath)) {
          setSelection({ kind: "dir", relPath: parentRelPath(input.relPath) })
        }
        setPendingDelete(null)
        void invalidateTree()
      },
    }),
  )
  const renameEntry = useMutation(
    trpc.files.rename.mutationOptions({
      onSuccess: (renamed, input) => {
        const from = input.relPath
        const to = renamed.relPath
        // Move each affected (clean) tab to the renamed path; dirty ones were refused before the call.
        for (const tab of affectedTabs(tabs, from)) {
          editorTabs?.closeFile(tab.relPath)
          onOpenFile(movedPath(tab.relPath, from, to))
        }
        const inside = (path: string) => path === from || path.startsWith(`${from}/`)
        if (inside(selection.relPath)) {
          setSelection({ ...selection, relPath: movedPath(selection.relPath, from, to) })
        }
        setExpandedDirs(
          (current) =>
            new Set([...current].map((path) => (inside(path) ? movedPath(path, from, to) : path))),
        )
        setRename(null)
        void invalidateTree()
      },
      onError: (error) =>
        setRename((current) =>
          current ? { ...current, pending: false, error: error.message } : current,
        ),
    }),
  )

  // Right-click selects the row (a file is not opened) before showing its menu.
  const onContextMenu = (entry: TreeEntryRef, event: React.MouseEvent) => {
    event.preventDefault()
    setSelection({ kind: entry.kind, relPath: entry.relPath })
    setMenu({ entry, x: event.clientX, y: event.clientY })
  }
  const unsavedTabPaths = (relPath: string): string[] =>
    affectedTabs(tabs, relPath)
      .filter((tab) => tab.dirty)
      .map((tab) => tab.relPath)
  // With confirmation turned off, trash at once unless unsaved tab changes would be lost.
  const requestDelete = (entry: TreeEntryRef) => {
    trash.reset()
    setActionError(null)
    if (confirmFileDelete || unsavedTabPaths(entry.relPath).length > 0) {
      setPendingDelete(entry)
      return
    }
    trash.mutate({ workspaceId, relPath: entry.relPath }, { onError: reportActionError })
  }
  const confirmDelete = (entry: TreeEntryRef, dontAskAgain: boolean) => {
    if (dontAskAgain) updateEditor.mutate({ confirmFileDelete: false })
    trash.mutate({ workspaceId, relPath: entry.relPath })
  }
  const startRename = (entry: TreeEntryRef) => {
    setActionError(null)
    setRename({ entry, value: entry.name, error: null, pending: false })
  }
  const submitRename = () => {
    if (!rename) return
    const name = rename.value.trim()
    if (name === rename.entry.name) {
      setRename(null)
      return
    }
    const error = validateEntryName(name)
    if (error) {
      setRename({ ...rename, error: t(error) })
      return
    }
    const unsaved = affectedTabs(tabs, rename.entry.relPath).filter((tab) => tab.dirty)
    if (unsaved.length > 0) {
      setRename({
        ...rename,
        error: `${t("Save or close tabs with unsaved changes before renaming: ")}${unsaved
          .map((tab) => tab.relPath)
          .join(", ")}`,
      })
      return
    }
    const parent = parentRelPath(rename.entry.relPath)
    setRename({ ...rename, error: null, pending: true })
    renameEntry.mutate({
      workspaceId,
      relPath: rename.entry.relPath,
      newRelPath: parent ? `${parent}/${name}` : name,
    })
  }
  const closeMenu = useCallback(() => setMenu(null), [])
  const cancelDelete = useCallback(() => setPendingDelete(null), [])
  const rowActions: TreeRowActions = {
    showHiddenFiles,
    selection,
    menuRelPath: menu?.entry.relPath ?? null,
    onSelect: setSelection,
    onFileClick: (relPath) => {
      setSelection({ kind: "file", relPath })
      onOpenFile(relPath)
    },
    onContextMenu,
    onDeleteRequest: requestDelete,
    rename,
    onRenameChange: (value) =>
      setRename((current) => (current ? { ...current, value, error: null } : current)),
    onRenameSubmit: submitRename,
    onRenameCancel: () => setRename(null),
  }

  const startDraft = (kind: CreateDraft["kind"], parentRelPath: string) => {
    createFile.reset()
    createFolder.reset()
    setValidationError(null)
    setDraftName("")
    setSelection({ kind: "dir", relPath: parentRelPath })
    setDraft({ kind, parentRelPath })
    if (parentRelPath) setExpandedDirs((current) => new Set(current).add(parentRelPath))
  }
  const cancelDraft = () => {
    createFile.reset()
    createFolder.reset()
    setValidationError(null)
    setDraftName("")
    setDraft(null)
  }
  const submitDraft = () => {
    if (!draft) return
    const name = draftName.trim()
    const error = validateEntryName(name)
    if (error) {
      setValidationError(t(error))
      return
    }
    const relPath = draft.parentRelPath ? `${draft.parentRelPath}/${name}` : name
    const input = { workspaceId, relPath }
    if (draft.kind === "file") createFile.mutate(input)
    else createFolder.mutate(input)
  }
  const createError =
    validationError ?? createFile.error?.message ?? createFolder.error?.message ?? null
  const creating = createFile.isPending || createFolder.isPending

  return (
    <div
      data-testid="file-tree"
      // A file opened from a row leaves keyboard focus on that row (see focusOnOpen).
      {...{ [HOLDS_FOCUS_ON_OPEN_ATTR]: "" }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center gap-1 border-border border-b px-2 py-1.5">
        <button
          type="button"
          data-testid="file-tree-root"
          data-selected={isSelected(selection, "dir", "")}
          title={t("Use project root for new files and folders")}
          onClick={() => setSelection(ROOT_SELECTION)}
          className="mr-auto rounded px-1 font-medium text-muted-foreground text-xs uppercase tracking-wide hover:text-foreground"
        >
          {t("Files")}
        </button>
        <button
          type="button"
          aria-label={t("New file")}
          title={`${t("New file in ")}${targetDir || t("project root")}`}
          onClick={() => startDraft("file", targetDir)}
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <FilePlus2 className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={t("New folder")}
          title={`${t("New folder in ")}${targetDir || t("project root")}`}
          onClick={() => startDraft("folder", targetDir)}
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <FolderPlus className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`${t("File sort: ")}${t(FILE_TREE_SORT_LABELS[sort])}`}
          data-testid="file-tree-sort"
          title={`${t("Sort files: ")}${t(FILE_TREE_SORT_LABELS[sort])}${t(". Click to cycle.")}`}
          onClick={nextSort}
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <FileTreeSortIcon sort={sort} />
        </button>
      </div>
      {actionError ? (
        <p
          role="alert"
          data-testid="file-tree-action-error"
          className="shrink-0 cursor-text select-text border-border border-b px-3 py-1.5 text-destructive text-xs leading-snug"
        >
          {actionError}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <TreeRowActionsContext.Provider value={rowActions}>
          <TreeLevel
            workspaceId={workspaceId}
            relPath=""
            depth={0}
            activeRelPath={activeRelPath}
            onOpenFile={onOpenFile}
            expandedDirs={expandedDirs}
            onToggleDir={(path) =>
              setExpandedDirs((current) => {
                const next = new Set(current)
                if (next.has(path)) next.delete(path)
                else next.add(path)
                return next
              })
            }
            draft={draft}
            draftName={draftName}
            createError={createError}
            creating={creating}
            sort={sort}
            onDraftNameChange={(name) => {
              setDraftName(name)
              setValidationError(null)
              createFile.reset()
              createFolder.reset()
            }}
            onSubmitDraft={submitDraft}
            onCancelDraft={cancelDraft}
          />
        </TreeRowActionsContext.Provider>
      </div>
      <FileTreeContextMenu
        menu={menu}
        onClose={closeMenu}
        actions={{
          onOpen: (entry) => onOpenFile(entry.relPath),
          onNewFile: (entry) => startDraft("file", entry.relPath),
          onNewFolder: (entry) => startDraft("folder", entry.relPath),
          onReveal: (entry) => {
            setActionError(null)
            reveal.mutate({ workspaceId, relPath: entry.relPath })
          },
          onCopyPath: (entry, form) => {
            setActionError(null)
            copyPath.mutate({ workspaceId, relPath: entry.relPath, form })
          },
          onRename: startRename,
          onDuplicate: (entry) => {
            setActionError(null)
            duplicate.mutate({ workspaceId, relPath: entry.relPath })
          },
          onDelete: requestDelete,
          onPin: onPinFile ? (entry) => onPinFile(entry.relPath) : undefined,
          onSetMain: onSetMainFile ? (entry) => onSetMainFile(entry.relPath) : undefined,
        }}
      />
      {pendingDelete ? (
        <DeleteConfirmDialog
          entry={pendingDelete}
          unsavedPaths={unsavedTabPaths(pendingDelete.relPath)}
          pending={trash.isPending}
          error={trash.error?.message ?? null}
          onCancel={cancelDelete}
          onConfirm={(dontAskAgain) => confirmDelete(pendingDelete, dontAskAgain)}
        />
      ) : null}
    </div>
  )
}

const FILE_TREE_SORT_CYCLE: FileTreeSort[] = ["name-asc", "name-desc", "type", "modified"]

const FILE_TREE_SORT_LABELS: Record<FileTreeSort, string> = {
  "name-asc": "Name A–Z",
  "name-desc": "Name Z–A",
  type: "Type",
  modified: "Modified date",
}

function FileTreeSortIcon({ sort }: { sort: FileTreeSort }) {
  const Icon =
    sort === "name-asc"
      ? ArrowDownAZ
      : sort === "name-desc"
        ? ArrowUpAZ
        : sort === "type"
          ? ListFilter
          : Clock3
  return <Icon className="size-3.5" aria-hidden />
}

interface TreeLevelProps {
  workspaceId: string
  /** Directory to list; "" is the workspace root. */
  relPath: string
  depth: number
  activeRelPath?: string | null
  onOpenFile: (relPath: string) => void
  expandedDirs: Set<string>
  onToggleDir: (relPath: string) => void
  draft: CreateDraft | null
  draftName: string
  createError: string | null
  creating: boolean
  sort: FileTreeSort
  onDraftNameChange: (name: string) => void
  onSubmitDraft: () => void
  onCancelDraft: () => void
}

/** The children of one directory, fetched lazily when this level mounts. */
function TreeLevel({
  workspaceId,
  relPath,
  depth,
  activeRelPath,
  onOpenFile,
  expandedDirs,
  onToggleDir,
  draft,
  draftName,
  createError,
  creating,
  sort,
  onDraftNameChange,
  onSubmitDraft,
  onCancelDraft,
}: TreeLevelProps) {
  const t = useTranslate()
  const trpc = useTRPC()
  const { showHiddenFiles } = useTreeRowActions()
  const query = useQuery(
    trpc.files.tree.queryOptions(
      { workspaceId, relPath },
      // The tree shifts when agents/git touch files; keep it fresh-ish without
      // hammering the FS, and refetch when the window regains focus.
      { staleTime: 10_000, refetchOnWindowFocus: true },
    ),
  )

  const hasDraft = draft?.parentRelPath === relPath
  if (query.isPending && !hasDraft) {
    return <LevelMessage depth={depth} testId="file-tree-loading" text={t("Loading…")} />
  }
  if (query.isError && !hasDraft) {
    return (
      <LevelMessage
        depth={depth}
        testId="file-tree-error"
        text={query.error.message}
        tone="error"
      />
    )
  }
  const listed = query.data ?? []
  const entries = sortEntries(
    showHiddenFiles ? listed : listed.filter((entry) => !entry.name.startsWith(".")),
    sort,
  )
  if (entries.length === 0 && depth === 0 && !hasDraft) {
    return <LevelMessage depth={depth} testId="file-tree-empty" text={t("No files")} />
  }

  return (
    <ul
      data-testid={`file-tree-level:${relPath || "root"}`}
      data-rel-path={relPath}
      className="flex flex-col"
    >
      {hasDraft ? (
        <CreateRow
          depth={depth}
          kind={draft.kind}
          value={draftName}
          error={createError}
          pending={creating}
          onChange={onDraftNameChange}
          onSubmit={onSubmitDraft}
          onCancel={onCancelDraft}
        />
      ) : null}
      {entries.map((entry) => (
        <TreeNode
          key={entry.relPath}
          workspaceId={workspaceId}
          entry={entry}
          depth={depth}
          activeRelPath={activeRelPath}
          onOpenFile={onOpenFile}
          expandedDirs={expandedDirs}
          onToggleDir={onToggleDir}
          draft={draft}
          draftName={draftName}
          createError={createError}
          creating={creating}
          sort={sort}
          onDraftNameChange={onDraftNameChange}
          onSubmitDraft={onSubmitDraft}
          onCancelDraft={onCancelDraft}
        />
      ))}
    </ul>
  )
}

interface TreeNodeProps {
  workspaceId: string
  entry: FileTreeEntry
  depth: number
  activeRelPath?: string | null
  onOpenFile: (relPath: string) => void
  expandedDirs: Set<string>
  onToggleDir: (relPath: string) => void
  draft: CreateDraft | null
  draftName: string
  createError: string | null
  creating: boolean
  sort: FileTreeSort
  onDraftNameChange: (name: string) => void
  onSubmitDraft: () => void
  onCancelDraft: () => void
}

/** A single file or directory row; directories expand their own `TreeLevel`. */
function TreeNode({
  workspaceId,
  entry,
  depth,
  activeRelPath,
  onOpenFile,
  expandedDirs,
  onToggleDir,
  draft,
  draftName,
  createError,
  creating,
  sort,
  onDraftNameChange,
  onSubmitDraft,
  onCancelDraft,
}: TreeNodeProps) {
  const t = useTranslate()
  const actions = useTreeRowActions()
  const expanded = expandedDirs.has(entry.relPath)
  const selected = isSelected(actions.selection, entry.kind, entry.relPath)
  const menuOpen = actions.menuRelPath === entry.relPath
  const indent = { paddingLeft: `${depth * 0.75 + 0.5}rem` }
  const ref: TreeEntryRef = { relPath: entry.relPath, name: entry.name, kind: entry.kind }
  const renaming = actions.rename?.entry.relPath === entry.relPath ? actions.rename : null
  const rowEvents = {
    onContextMenu: (event: React.MouseEvent) => actions.onContextMenu(ref, event),
    // Tabbing or clicking into a row selects it.
    onFocus: (event: React.FocusEvent) => {
      if (event.target === event.currentTarget)
        actions.onSelect({ kind: entry.kind, relPath: entry.relPath })
    },
    // ⌘⌫ on the focused row; the inline rename input is a different element, so typing there never deletes.
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.target !== event.currentTarget || !isDeleteChord(event)) return
      event.preventDefault()
      actions.onDeleteRequest(ref)
    },
  }
  const renameRow = renaming ? (
    <RenameRow
      depth={depth}
      entry={ref}
      expanded={expanded}
      draft={renaming}
      onChange={actions.onRenameChange}
      onSubmit={actions.onRenameSubmit}
      onCancel={actions.onRenameCancel}
    />
  ) : null

  if (entry.kind === "dir") {
    return (
      <li>
        {renameRow ?? (
          <button
            {...rowEvents}
            type="button"
            data-testid="file-tree-dir"
            data-rel-path={entry.relPath}
            data-selected={selected}
            data-menu-open={menuOpen || undefined}
            data-feature-label={t("Folder")}
            data-feature-help={t("Expand or collapse this folder in the project file tree")}
            onClick={(event) => {
              // Focus the row explicitly so ⌘⌫ reaches it even where a click does not focus buttons.
              event.currentTarget.focus()
              actions.onSelect({ kind: "dir", relPath: entry.relPath })
              onToggleDir(entry.relPath)
            }}
            style={indent}
            className={cn(
              "flex w-full cursor-pointer items-center gap-1 py-1 pr-2 text-left text-foreground/90 text-xs hover:bg-accent/60",
              selected && "bg-accent/50 text-foreground",
              selected && menuOpen && "bg-accent/60",
            )}
          >
            {expanded ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <CodIcon src={folderIconUrl(expanded)} className="size-4" />
            <span className="truncate">{entry.name}</span>
          </button>
        )}
        {expanded ? (
          <TreeLevel
            workspaceId={workspaceId}
            relPath={entry.relPath}
            depth={depth + 1}
            activeRelPath={activeRelPath}
            onOpenFile={onOpenFile}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
            draft={draft}
            draftName={draftName}
            createError={createError}
            creating={creating}
            sort={sort}
            onDraftNameChange={onDraftNameChange}
            onSubmitDraft={onSubmitDraft}
            onCancelDraft={onCancelDraft}
          />
        ) : null}
      </li>
    )
  }

  const active = entry.relPath === activeRelPath
  if (renameRow) return <li>{renameRow}</li>
  return (
    <li>
      <button
        {...rowEvents}
        type="button"
        data-testid="file-tree-file"
        data-rel-path={entry.relPath}
        data-selected={selected}
        data-menu-open={menuOpen || undefined}
        data-feature-label={t("File")}
        data-feature-help={t("Open this project file in a built-in editor tab")}
        onClick={(event) => {
          // Focus the row explicitly so ⌘⌫ reaches it even where a click does not focus buttons.
          event.currentTarget.focus()
          actions.onFileClick(entry.relPath)
        }}
        // Drag a file into the central panel to open it in a split.
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(FILE_DRAG_TYPE, entry.relPath)
          event.dataTransfer.effectAllowed = "copyMove"
        }}
        style={indent}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex w-full cursor-pointer items-center gap-1 py-1 pr-2 text-left text-muted-foreground text-xs hover:bg-accent/60 hover:text-foreground",
          selected && "bg-accent/50 text-foreground",
          selected && menuOpen && "bg-accent/60",
        )}
      >
        {/* Spacer the width of the dir chevron so files align under directories. */}
        <span className="size-3.5 shrink-0" aria-hidden />
        <CodIcon src={fileIconUrl(entry.name)} className="size-4 opacity-80" />
        <span className="truncate">{entry.name}</span>
        {active ? (
          <Eye
            data-testid="file-tree-focused"
            className="ml-auto size-3.5 shrink-0 text-muted-foreground"
            aria-label={t("Focused in editor")}
          />
        ) : null}
      </button>
    </li>
  )
}

function CreateRow({
  depth,
  kind,
  value,
  error,
  pending,
  onChange,
  onSubmit,
  onCancel,
}: {
  depth: number
  kind: CreateDraft["kind"]
  value: string
  error: string | null
  pending: boolean
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const t = useTranslate()
  const label = kind === "file" ? t("New file name") : t("New folder name")
  return (
    <li
      data-testid="file-tree-create-row"
      className="flex flex-col gap-1 py-1 pr-2"
      style={{ paddingLeft: `${depth * 0.75 + 0.5}rem` }}
    >
      <div className="flex items-center gap-1">
        <span className="size-3.5 shrink-0" aria-hidden />
        <CodIcon
          src={kind === "file" ? fileIconUrl(value) : folderIconUrl(false)}
          className="size-4 opacity-80"
        />
        <input
          // biome-ignore lint/a11y/noAutofocus: inline creation is explicitly user-triggered and the name field is the next required action.
          autoFocus
          aria-label={label}
          value={value}
          disabled={pending}
          placeholder={kind === "file" ? t("file name") : t("folder name")}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              onSubmit()
            } else if (event.key === "Escape") {
              event.preventDefault()
              onCancel()
            }
          }}
          className="h-6 min-w-0 flex-1 rounded border border-ring bg-background px-1.5 text-foreground text-xs outline-none"
        />
        <button
          type="button"
          aria-label={t("Cancel creation")}
          title={t("Cancel")}
          onClick={onCancel}
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      {error ? (
        <p
          data-testid="file-tree-create-error"
          className="cursor-text select-text pl-8 text-destructive text-[11px] leading-snug"
        >
          {error}
        </p>
      ) : null}
    </li>
  )
}

/**
 * Inline rename input that replaces a row. The name stem (before the extension)
 * is preselected so typing replaces it; Enter submits and Escape cancels.
 */
function RenameRow({
  depth,
  entry,
  expanded,
  draft,
  onChange,
  onSubmit,
  onCancel,
}: {
  depth: number
  entry: TreeEntryRef
  expanded: boolean
  draft: RenameDraft
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const t = useTranslate()
  const selectStem = useCallback(
    (input: HTMLInputElement | null) => {
      if (!input) return
      input.focus()
      const dot = entry.kind === "file" ? entry.name.lastIndexOf(".") : -1
      input.setSelectionRange(0, dot > 0 ? dot : entry.name.length)
    },
    [entry.kind, entry.name],
  )
  return (
    <div
      data-testid="file-tree-rename-row"
      data-rel-path={entry.relPath}
      className="flex flex-col gap-1 py-1 pr-2"
      style={{ paddingLeft: `${depth * 0.75 + 0.5}rem` }}
    >
      <div className="flex items-center gap-1">
        <span className="size-3.5 shrink-0" aria-hidden />
        <CodIcon
          src={entry.kind === "file" ? fileIconUrl(draft.value) : folderIconUrl(expanded)}
          className="size-4 opacity-80"
        />
        <input
          ref={selectStem}
          aria-label={`${t("Rename ")}${entry.name}`}
          value={draft.value}
          disabled={draft.pending}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              onSubmit()
            } else if (event.key === "Escape") {
              event.preventDefault()
              onCancel()
            }
          }}
          className="h-6 min-w-0 flex-1 rounded border border-ring bg-background px-1.5 text-foreground text-xs outline-none"
        />
        <button
          type="button"
          aria-label={t("Cancel rename")}
          title={t("Cancel")}
          onClick={onCancel}
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      {draft.error ? (
        <p
          data-testid="file-tree-rename-error"
          className="cursor-text select-text pl-8 text-destructive text-[11px] leading-snug"
        >
          {draft.error}
        </p>
      ) : null}
    </div>
  )
}

/** Directories always lead; the remembered mode sorts within each kind. */
function sortEntries(entries: FileTreeEntry[], sort: FileTreeSort): FileTreeEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1
    const byName = left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    if (sort === "name-desc") return -byName
    if (sort === "type" && left.kind === "file") {
      const byType = entryType(left).localeCompare(entryType(right))
      return byType || byName
    }
    if (sort === "modified") {
      const byModified = (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0)
      return byModified || byName
    }
    return byName
  })
}

/** Backward-compatible type fallback for cached/tests entries lacking metadata. */
function entryType(entry: FileTreeEntry): string {
  if (entry.type) return entry.type
  const dot = entry.name.lastIndexOf(".")
  return dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "file"
}

function validateEntryName(name: string): string | null {
  if (!name) return "Enter a name"
  if (name === "." || name === "..") return "Choose a regular file or folder name"
  if (name.includes("/") || name.includes("\\")) return "Names cannot contain path separators"
  if (name.includes("\0")) return "Names cannot contain null characters"
  return null
}

/**
 * Render a monochrome codicon SVG via a CSS mask so it paints in `currentColor` —
 * the icon adapts to the row's text colour and to the light/dark theme from one set.
 */
function CodIcon({ src, className }: { src: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0 bg-current", className)}
      style={{
        maskImage: `url("${src}")`,
        WebkitMaskImage: `url("${src}")`,
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
        maskSize: "contain",
        WebkitMaskSize: "contain",
      }}
    />
  )
}

function LevelMessage({
  depth,
  testId,
  text,
  tone,
}: {
  depth: number
  testId: string
  text: string
  tone?: "error"
}) {
  return (
    <p
      data-testid={testId}
      style={{ paddingLeft: `${depth * 0.75 + 0.75}rem` }}
      className={
        tone === "error"
          ? "cursor-text select-text py-1 text-destructive text-xs"
          : "py-1 text-muted-foreground/70 text-xs"
      }
    >
      {text}
    </p>
  )
}
