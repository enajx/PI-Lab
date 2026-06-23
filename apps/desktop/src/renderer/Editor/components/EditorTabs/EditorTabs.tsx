import { cn } from "@skipper/ui"
import { X } from "lucide-react"

/** One open buffer's tab metadata (the parent owns the full buffer state). */
export interface EditorTab {
  /** Path relative to the workspace working dir — the buffer's stable identity. */
  relPath: string
  /** Whether the buffer has unsaved edits (drives the dirty dot). */
  dirty: boolean
}

interface EditorTabsProps {
  tabs: EditorTab[]
  /** `relPath` of the currently shown buffer, or null when nothing is open. */
  activeRelPath: string | null
  onSelect: (relPath: string) => void
  onClose: (relPath: string) => void
}

/**
 * The strip of open-file tabs above the editor buffer. Each tab shows the file's
 * basename, a dirty dot when there are unsaved edits, and a close button. The
 * active tab is highlighted. Purely presentational — all buffer/dirty state
 * lives in the parent `Editor`.
 *
 * Horizontal overflow scrolls natively (a single bounded row), per AGENTS.md
 * §12.3 — no Radix ScrollArea.
 */
export function EditorTabs({ tabs, activeRelPath, onSelect, onClose }: EditorTabsProps) {
  return (
    <div
      data-testid="editor-tabs"
      className="flex shrink-0 items-stretch overflow-x-auto border-border border-b bg-muted/30"
    >
      {tabs.map((tab) => {
        const active = tab.relPath === activeRelPath
        return (
          <div
            key={tab.relPath}
            data-testid="editor-tab"
            data-active={active}
            data-dirty={tab.dirty}
            className={cn(
              "group flex max-w-[16rem] shrink-0 items-center gap-1.5 border-border/60 border-r px-3 py-1.5 text-xs transition-colors",
              active
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(tab.relPath)}
              aria-pressed={active}
              className="min-w-0 cursor-pointer truncate text-left"
              title={tab.relPath}
            >
              {basename(tab.relPath)}
            </button>
            {tab.dirty ? (
              <span
                data-testid="editor-dirty"
                title="Unsaved changes"
                className="size-1.5 shrink-0 rounded-full bg-foreground/70"
              />
            ) : null}
            <button
              type="button"
              data-testid="editor-tab-close"
              aria-label={`Close ${basename(tab.relPath)}`}
              onClick={() => onClose(tab.relPath)}
              className="shrink-0 rounded p-0.5 text-muted-foreground/60 opacity-0 transition hover:bg-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100"
            >
              <X className="size-3" aria-hidden />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** Final path segment of a POSIX relative path. */
function basename(relPath: string): string {
  return relPath.split("/").pop() ?? relPath
}
