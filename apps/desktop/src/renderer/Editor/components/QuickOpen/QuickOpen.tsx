import { useQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { useTRPC } from "../../../trpc/react"

interface QuickOpenProps {
  workspaceId: string
  /** Open the chosen file into the editor (working-dir-relative path). */
  onOpenFile: (relPath: string) => void
  /** Dismiss the palette without opening anything. */
  onClose: () => void
}

const DEBOUNCE_MS = 120

/**
 * `⌘F` fuzzy quick-open palette (docs/architecture.md (renderer)). Typing debounces a `files.search`
 * fuzzy query against the workspace; ↑/↓ move the highlight, Enter opens the
 * highlighted hit, Esc dismisses. Rendered as a centered overlay by the parent
 * `Editor`, which mounts it only while open.
 *
 * Results scroll in a native bounded list (AGENTS.md Pitfalls #3). The palette owns no
 * file I/O — it only turns a chosen path into an `onOpenFile` call.
 */
export function QuickOpen({ workspaceId, onOpenFile, onClose }: QuickOpenProps) {
  const trpc = useTRPC()
  const [query, setQuery] = useState("")
  const [debounced, setDebounced] = useState("")
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Focus the input as soon as the palette mounts.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Esc closes the palette from anywhere (the input also handles it, but a
  // window listener covers focus landing elsewhere first).
  useEffect(() => {
    const onWindowKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onWindowKey)
    return () => window.removeEventListener("keydown", onWindowKey)
  }, [onClose])

  // Debounce the live query so each keystroke doesn't walk the tree.
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [query])

  const searchQuery = useQuery(
    trpc.files.search.queryOptions(
      { workspaceId, query: debounced, limit: 50 },
      // An empty query returns [] from the router; keep results around briefly so
      // arrowing/selecting doesn't re-walk on every render.
      { staleTime: 5_000, enabled: debounced.trim().length > 0 },
    ),
  )
  const hits = debounced.trim().length > 0 ? (searchQuery.data ?? []) : []

  // Reset the highlight to the top whenever the query (and thus the result set)
  // changes, so Enter always targets the best match for the current input.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed to the query changing, not to a value read in the body
  useEffect(() => {
    setHighlight(0)
  }, [debounced])

  const choose = (index: number) => {
    const hit = hits[index]
    if (hit) onOpenFile(hit.relPath)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      onClose()
    } else if (event.key === "ArrowDown") {
      event.preventDefault()
      setHighlight((value) => Math.min(value + 1, Math.max(hits.length - 1, 0)))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setHighlight((value) => Math.max(value - 1, 0))
    } else if (event.key === "Enter") {
      event.preventDefault()
      choose(highlight)
    }
  }

  return (
    <div
      data-testid="quick-open-backdrop"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
    >
      {/* A full-screen click target that dismisses the palette (a real button so
          it's keyboard-reachable; the dialog sits above it). */}
      <button
        type="button"
        aria-label="Close quick open"
        tabIndex={-1}
        onClick={onClose}
        className="-z-10 absolute inset-0 cursor-default bg-black/40"
      />
      <div
        data-testid="quick-open"
        className="flex max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Quick open file"
      >
        <input
          ref={inputRef}
          data-testid="quick-open-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search files by name…"
          className="shrink-0 border-border border-b bg-transparent px-4 py-3 text-foreground text-sm outline-none placeholder:text-muted-foreground"
        />
        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {hits.length === 0 ? (
            <li
              data-testid="quick-open-empty"
              className="px-4 py-2 text-muted-foreground/70 text-xs"
            >
              {debounced.trim().length === 0 ? "Type to search files" : "No matching files"}
            </li>
          ) : (
            hits.map((hit, index) => (
              <li key={hit.relPath}>
                <button
                  type="button"
                  data-testid="quick-open-result"
                  data-rel-path={hit.relPath}
                  data-highlighted={index === highlight}
                  onClick={() => choose(index)}
                  onMouseEnter={() => setHighlight(index)}
                  className={
                    index === highlight
                      ? "flex w-full items-center gap-2 bg-accent px-4 py-1.5 text-left text-foreground text-xs"
                      : "flex w-full items-center gap-2 px-4 py-1.5 text-left text-muted-foreground text-xs hover:bg-accent/60"
                  }
                >
                  <span className="truncate font-medium text-foreground">
                    {basename(hit.relPath)}
                  </span>
                  <span className="truncate text-muted-foreground/70">{dirname(hit.relPath)}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}

function basename(relPath: string): string {
  return relPath.split("/").pop() ?? relPath
}

function dirname(relPath: string): string {
  const idx = relPath.lastIndexOf("/")
  return idx === -1 ? "" : relPath.slice(0, idx)
}
