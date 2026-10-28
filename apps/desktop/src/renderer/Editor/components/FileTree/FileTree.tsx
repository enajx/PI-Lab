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
  Pin,
  X,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslate } from "../../../i18n/language"
import { type FileTreeSort, useFileTreeSort } from "../../../preferences/preferences"
import { useTRPC } from "../../../trpc/react"
import type { FileTreeEntry } from "../../../trpc/types"
import { FILE_DRAG_TYPE } from "../../fileDrag"
import { fileIconUrl, folderIconUrl } from "./fileIcons"

/** Position + target of the file row's right-click menu. */
interface FileMenuState {
  relPath: string
  x: number
  y: number
}

/** A right-click on a `.md` file row hands its path and cursor position up. */
type ContextMenuFile = (relPath: string, event: React.MouseEvent) => void

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
}

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
 * Scrolling is a native bounded `min-h-0 flex-1 overflow-y-auto` column
 * — no Radix ScrollArea.
 */
export function FileTree({
  workspaceId,
  onOpenFile,
  activeRelPath,
  onPinFile,
  onSetMainFile,
}: FileTreeProps) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [menu, setMenu] = useState<FileMenuState | null>(null)
  const [selectedDir, setSelectedDir] = useState("")
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
        setSelectedDir(created.relPath)
        setExpandedDirs((current) => new Set(current).add(created.relPath))
      },
    }),
  )

  // Only offer the right-click menu when the host can act on a pin.
  const onContextMenuFile: ContextMenuFile | undefined =
    onPinFile || onSetMainFile
      ? (relPath, event) => {
          event.preventDefault()
          setMenu({ relPath, x: event.clientX, y: event.clientY })
        }
      : undefined

  const startDraft = (kind: CreateDraft["kind"]) => {
    createFile.reset()
    createFolder.reset()
    setValidationError(null)
    setDraftName("")
    setDraft({ kind, parentRelPath: selectedDir })
    if (selectedDir) setExpandedDirs((current) => new Set(current).add(selectedDir))
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
    <div data-testid="file-tree" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-border border-b px-2 py-1.5">
        <button
          type="button"
          data-testid="file-tree-root"
          data-selected={selectedDir === ""}
          title={t("Use project root for new files and folders")}
          onClick={() => setSelectedDir("")}
          className="mr-auto rounded px-1 font-medium text-muted-foreground text-xs uppercase tracking-wide hover:text-foreground"
        >
          {t("Files")}
        </button>
        <button
          type="button"
          aria-label={t("New file")}
          title={`${t("New file in ")}${selectedDir || t("project root")}`}
          onClick={() => startDraft("file")}
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <FilePlus2 className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={t("New folder")}
          title={`${t("New folder in ")}${selectedDir || t("project root")}`}
          onClick={() => startDraft("folder")}
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
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <TreeLevel
          workspaceId={workspaceId}
          relPath=""
          depth={0}
          activeRelPath={activeRelPath}
          onOpenFile={onOpenFile}
          onContextMenuFile={onContextMenuFile}
          selectedDir={selectedDir}
          expandedDirs={expandedDirs}
          onSelectDir={setSelectedDir}
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
      </div>
      <FileTreeContextMenu
        menu={menu}
        onClose={() => setMenu(null)}
        onPin={(relPath) => {
          onPinFile?.(relPath)
          setMenu(null)
        }}
        onSetMain={(relPath) => {
          onSetMainFile?.(relPath)
          setMenu(null)
        }}
        canPin={Boolean(onPinFile)}
        canSetMain={Boolean(onSetMainFile)}
      />
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

/**
 * The right-click menu for a `.md` file row, rendered once at the tree root and
 * positioned at the cursor (mirrors the sidebar's `ProjectContextMenu`). Its only
 * action pins the file as a right-sidebar panel. Closes on outside mousedown or
 * Escape; the action click stays inside `rootRef` so it doesn't self-close early.
 */
function FileTreeContextMenu({
  menu,
  onClose,
  onPin,
  onSetMain,
  canPin,
  canSetMain,
}: {
  menu: FileMenuState | null
  onClose: () => void
  onPin: (relPath: string) => void
  onSetMain: (relPath: string) => void
  canPin: boolean
  canSetMain: boolean
}) {
  const t = useTranslate()
  const rootRef = useRef<HTMLDivElement | null>(null)

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

  if (!menu) return null
  return (
    <div
      ref={rootRef}
      data-testid="file-tree-context-menu"
      role="menu"
      className="fixed z-50 w-52 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
      style={{ left: menu.x, top: menu.y }}
    >
      {canPin ? (
        <button
          type="button"
          role="menuitem"
          data-testid="file-tree-pin"
          data-rel-path={menu.relPath}
          data-feature-label={t("Pin as panel")}
          data-feature-help={t(
            "Pin this Markdown file as a persistent panel in the project's right sidebar",
          )}
          onClick={() => onPin(menu.relPath)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
        >
          <Pin className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{t("Pin as panel")}</span>
        </button>
      ) : null}
      {canSetMain ? (
        <button
          type="button"
          role="menuitem"
          data-testid="file-tree-set-main"
          onClick={() => onSetMain(menu.relPath)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
        >
          {t("Set as main readme")}
        </button>
      ) : null}
    </div>
  )
}

interface TreeLevelProps {
  workspaceId: string
  /** Directory to list; "" is the workspace root. */
  relPath: string
  depth: number
  activeRelPath?: string | null
  onOpenFile: (relPath: string) => void
  onContextMenuFile?: ContextMenuFile
  selectedDir: string
  expandedDirs: Set<string>
  onSelectDir: (relPath: string) => void
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
  onContextMenuFile,
  selectedDir,
  expandedDirs,
  onSelectDir,
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
  const entries = sortEntries(query.data ?? [], sort)
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
          onContextMenuFile={onContextMenuFile}
          selectedDir={selectedDir}
          expandedDirs={expandedDirs}
          onSelectDir={onSelectDir}
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
  onContextMenuFile?: ContextMenuFile
  selectedDir: string
  expandedDirs: Set<string>
  onSelectDir: (relPath: string) => void
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
  onContextMenuFile,
  selectedDir,
  expandedDirs,
  onSelectDir,
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
  const expanded = expandedDirs.has(entry.relPath)
  const selected = selectedDir === entry.relPath
  const indent = { paddingLeft: `${depth * 0.75 + 0.5}rem` }

  if (entry.kind === "dir") {
    return (
      <li>
        <button
          type="button"
          data-testid="file-tree-dir"
          data-rel-path={entry.relPath}
          data-selected={selected}
          data-feature-label={t("Folder")}
          data-feature-help={t("Expand or collapse this folder in the project file tree")}
          onClick={() => {
            onSelectDir(entry.relPath)
            onToggleDir(entry.relPath)
          }}
          style={indent}
          className={cn(
            "flex w-full cursor-pointer items-center gap-1 py-1 pr-2 text-left text-foreground/90 text-xs transition-colors hover:bg-accent/60",
            selected && "bg-accent/50 text-foreground",
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
        {expanded ? (
          <TreeLevel
            workspaceId={workspaceId}
            relPath={entry.relPath}
            depth={depth + 1}
            activeRelPath={activeRelPath}
            onOpenFile={onOpenFile}
            onContextMenuFile={onContextMenuFile}
            selectedDir={selectedDir}
            expandedDirs={expandedDirs}
            onSelectDir={onSelectDir}
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
  return (
    <li>
      <button
        type="button"
        data-testid="file-tree-file"
        data-rel-path={entry.relPath}
        data-feature-label={t("File")}
        data-feature-help={t("Open this project file in a built-in editor tab")}
        onClick={() => onOpenFile(entry.relPath)}
        // Drag a file into the central panel to open it in a split.
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(FILE_DRAG_TYPE, entry.relPath)
          event.dataTransfer.effectAllowed = "copyMove"
        }}
        // Right-click a Markdown file to pin it as a right-sidebar panel.
        onContextMenu={
          onContextMenuFile && entry.name.endsWith(".md")
            ? (event) => onContextMenuFile(entry.relPath, event)
            : undefined
        }
        style={indent}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex w-full cursor-pointer items-center gap-1 py-1 pr-2 text-left text-muted-foreground text-xs transition-colors hover:bg-accent/60 hover:text-foreground",
          active && "bg-accent/50 text-foreground",
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
