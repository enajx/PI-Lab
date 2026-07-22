import { cn } from "@pi-lab/ui"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, Eye, Pin } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTRPC } from "../../../trpc/react"
import type { FileTreeEntry } from "../../../trpc/types"
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
}

/**
 * Lazy workspace file tree (md/engineering/architecture.md (renderer)). The root level is listed via
 * `files.tree` with an empty path; each directory expands on click, fetching its
 * own children on demand so a large repo never walks the whole tree up front.
 * Files open into the editor on click.
 *
 * Scrolling is a native bounded `min-h-0 flex-1 overflow-y-auto` column
 * (AGENTS.md Pitfalls #3) — no Radix ScrollArea.
 */
export function FileTree({ workspaceId, onOpenFile, activeRelPath, onPinFile }: FileTreeProps) {
  const [menu, setMenu] = useState<FileMenuState | null>(null)
  // Only offer the right-click menu when the host can act on a pin.
  const onContextMenuFile: ContextMenuFile | undefined = onPinFile
    ? (relPath, event) => {
        event.preventDefault()
        setMenu({ relPath, x: event.clientX, y: event.clientY })
      }
    : undefined

  return (
    <div data-testid="file-tree" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-border border-b px-3 py-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Files
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <TreeLevel
          workspaceId={workspaceId}
          relPath=""
          depth={0}
          activeRelPath={activeRelPath}
          onOpenFile={onOpenFile}
          onContextMenuFile={onContextMenuFile}
        />
      </div>
      <FileTreeContextMenu
        menu={menu}
        onClose={() => setMenu(null)}
        onPin={(relPath) => {
          onPinFile?.(relPath)
          setMenu(null)
        }}
      />
    </div>
  )
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
}: {
  menu: FileMenuState | null
  onClose: () => void
  onPin: (relPath: string) => void
}) {
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
      <button
        type="button"
        role="menuitem"
        data-testid="file-tree-pin"
        data-rel-path={menu.relPath}
        data-feature-label="Pin as panel"
        data-feature-help="Pin this Markdown file as a persistent panel in the project's right sidebar"
        onClick={() => onPin(menu.relPath)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
      >
        <Pin className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">Pin as panel</span>
      </button>
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
}

/** The children of one directory, fetched lazily when this level mounts. */
function TreeLevel({
  workspaceId,
  relPath,
  depth,
  activeRelPath,
  onOpenFile,
  onContextMenuFile,
}: TreeLevelProps) {
  const trpc = useTRPC()
  const query = useQuery(
    trpc.files.tree.queryOptions(
      { workspaceId, relPath },
      // The tree shifts when agents/git touch files; keep it fresh-ish without
      // hammering the FS, and refetch when the window regains focus.
      { staleTime: 10_000, refetchOnWindowFocus: true },
    ),
  )

  if (query.isPending) {
    return <LevelMessage depth={depth} testId="file-tree-loading" text="Loading…" />
  }
  if (query.isError) {
    return (
      <LevelMessage
        depth={depth}
        testId="file-tree-error"
        text={query.error.message}
        tone="error"
      />
    )
  }
  const entries = query.data ?? []
  if (entries.length === 0 && depth === 0) {
    return <LevelMessage depth={depth} testId="file-tree-empty" text="No files" />
  }

  return (
    <ul className="flex flex-col">
      {entries.map((entry) => (
        <TreeNode
          key={entry.relPath}
          workspaceId={workspaceId}
          entry={entry}
          depth={depth}
          activeRelPath={activeRelPath}
          onOpenFile={onOpenFile}
          onContextMenuFile={onContextMenuFile}
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
}

/** A single file or directory row; directories expand their own `TreeLevel`. */
function TreeNode({
  workspaceId,
  entry,
  depth,
  activeRelPath,
  onOpenFile,
  onContextMenuFile,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const indent = { paddingLeft: `${depth * 0.75 + 0.5}rem` }

  if (entry.kind === "dir") {
    return (
      <li>
        <button
          type="button"
          data-testid="file-tree-dir"
          data-rel-path={entry.relPath}
          data-feature-label="Folder"
          data-feature-help="Expand or collapse this folder in the project file tree"
          onClick={() => setExpanded((value) => !value)}
          style={indent}
          className="flex w-full cursor-pointer items-center gap-1 py-1 pr-2 text-left text-foreground/90 text-xs transition-colors hover:bg-accent/60"
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
        data-feature-label="File"
        data-feature-help="Open this project file in a built-in editor tab"
        onClick={() => onOpenFile(entry.relPath)}
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
            aria-label="Focused in editor"
          />
        ) : null}
      </button>
    </li>
  )
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
