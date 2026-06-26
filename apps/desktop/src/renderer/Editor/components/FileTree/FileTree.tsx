import { cn } from "@skipper/ui"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronRight } from "lucide-react"
import { useState } from "react"
import { useTRPC } from "../../../trpc/react"
import type { FileTreeEntry } from "../../../trpc/types"
import { fileIconUrl, folderIconUrl } from "./fileIcons"

interface FileTreeProps {
  workspaceId: string
  /** Open a file in the editor (called with its working-dir-relative path). */
  onOpenFile: (relPath: string) => void
}

/**
 * Lazy workspace file tree (docs/architecture.md (renderer)). The root level is listed via
 * `files.tree` with an empty path; each directory expands on click, fetching its
 * own children on demand so a large repo never walks the whole tree up front.
 * Files open into the editor on click.
 *
 * Scrolling is a native bounded `min-h-0 flex-1 overflow-y-auto` column
 * (AGENTS.md Pitfalls #3) — no Radix ScrollArea.
 */
export function FileTree({ workspaceId, onOpenFile }: FileTreeProps) {
  return (
    <div data-testid="file-tree" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-border border-b px-3 py-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Files
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <TreeLevel workspaceId={workspaceId} relPath="" depth={0} onOpenFile={onOpenFile} />
      </div>
    </div>
  )
}

interface TreeLevelProps {
  workspaceId: string
  /** Directory to list; "" is the workspace root. */
  relPath: string
  depth: number
  onOpenFile: (relPath: string) => void
}

/** The children of one directory, fetched lazily when this level mounts. */
function TreeLevel({ workspaceId, relPath, depth, onOpenFile }: TreeLevelProps) {
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
          onOpenFile={onOpenFile}
        />
      ))}
    </ul>
  )
}

interface TreeNodeProps {
  workspaceId: string
  entry: FileTreeEntry
  depth: number
  onOpenFile: (relPath: string) => void
}

/** A single file or directory row; directories expand their own `TreeLevel`. */
function TreeNode({ workspaceId, entry, depth, onOpenFile }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const indent = { paddingLeft: `${depth * 0.75 + 0.5}rem` }

  if (entry.kind === "dir") {
    return (
      <li>
        <button
          type="button"
          data-testid="file-tree-dir"
          data-rel-path={entry.relPath}
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
            onOpenFile={onOpenFile}
          />
        ) : null}
      </li>
    )
  }

  return (
    <li>
      <button
        type="button"
        data-testid="file-tree-file"
        data-rel-path={entry.relPath}
        onClick={() => onOpenFile(entry.relPath)}
        style={indent}
        className="flex w-full cursor-pointer items-center gap-1 py-1 pr-2 text-left text-muted-foreground text-xs transition-colors hover:bg-accent/60 hover:text-foreground"
      >
        {/* Spacer the width of the dir chevron so files align under directories. */}
        <span className="size-3.5 shrink-0" aria-hidden />
        <CodIcon src={fileIconUrl(entry.name)} className="size-4 opacity-80" />
        <span className="truncate">{entry.name}</span>
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
