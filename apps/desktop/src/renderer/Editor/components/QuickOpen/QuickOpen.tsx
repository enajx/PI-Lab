import { fuzzyMatch } from "@pi-lab/shared/search/fuzzy"
import { useQuery } from "@tanstack/react-query"
import { FolderGit2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslate } from "../../../i18n/language"
import { useTRPC } from "../../../trpc/react"

interface QuickOpenProps {
  workspaceId: string
  /** Name of the active project, shown in the scope label when available. */
  projectName?: string
  /** Open the chosen file into the editor (working-dir-relative path). */
  onOpenFile: (relPath: string) => void
  /** Dismiss the palette without opening anything. */
  onClose: () => void
  /** Optional predicate restricting which results are shown/selectable (e.g. `.md` only). */
  filter?: (relPath: string) => boolean
}

const DEBOUNCE_MS = 120

/**
 * `⌘F` fuzzy quick-open palette. Typing debounces a `files.search`
 * fuzzy query against the workspace; ↑/↓ move the highlight, Enter opens the
 * highlighted hit, Esc dismisses. Rendered as a centered overlay by the parent
 * `Editor`, which mounts it only while open.
 *
 * Results scroll in a native bounded list. The palette owns no
 * file I/O — it only turns a chosen path into an `onOpenFile` call.
 */
export function QuickOpen({
  workspaceId,
  projectName,
  onOpenFile,
  onClose,
  filter,
}: QuickOpenProps) {
  const t = useTranslate()
  const trpc = useTRPC()
  const [query, setQuery] = useState("")
  const [debounced, setDebounced] = useState("")
  const [highlight, setHighlight] = useState(0)
  const [global, setGlobal] = useState(false)
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
      // Keep results around briefly so arrowing/selecting doesn't re-walk on
      // every render.
      { staleTime: 5_000, enabled: !global && debounced.trim().length > 0 },
    ),
  )
  const allHits = debounced.trim().length > 0 ? (searchQuery.data?.hits ?? []) : []
  const hits = filter ? allHits.filter((hit) => filter(hit.relPath)) : allHits
  const projects = useQuery(trpc.projects.list.queryOptions()).data ?? []
  const globalProjects = useMemo(() => {
    const needle = query.trim()
    return needle
      ? projects.filter((project) => fuzzyMatch(needle, project.name) !== null)
      : projects
  }, [projects, query])

  // Reset the highlight to the top whenever the query (and thus the result set)
  // changes, so Enter always targets the best match for the current input.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed to the query changing, not to a value read in the body
  useEffect(() => {
    setHighlight(0)
  }, [debounced])

  const choose = (index: number) => {
    if (global) {
      const project = globalProjects[index]
      if (project) {
        onClose()
        window.location.hash = `#/projects/${project.id}`
      }
      return
    }
    const hit = hits[index]
    if (hit) onOpenFile(hit.relPath)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      onClose()
    } else if (event.key === "ArrowDown") {
      event.preventDefault()
      setHighlight((value) =>
        Math.min(value + 1, Math.max((global ? globalProjects : hits).length - 1, 0)),
      )
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setHighlight((value) => Math.max(value - 1, 0))
    } else if (event.key === "Enter") {
      event.preventDefault()
      choose(highlight)
    } else if (event.key === "Tab") {
      event.preventDefault()
      setGlobal((value) => !value)
      setHighlight(0)
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
        aria-label={t("Close quick open")}
        data-feature-help={t("Close file search without opening a file")}
        tabIndex={-1}
        onClick={onClose}
        className="-z-10 absolute inset-0 cursor-default bg-black/40"
      />
      <div
        data-testid="quick-open"
        className="flex max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={t("Quick open file")}
      >
        <input
          ref={inputRef}
          data-testid="quick-open-input"
          aria-label={t("Search project files")}
          data-feature-help={t("Search this project's files by name")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("Search files by name…")}
          className="shrink-0 border-border border-b bg-transparent px-4 py-3 text-foreground text-sm outline-none placeholder:text-muted-foreground"
        />
        <div
          data-testid="quick-open-scope"
          className="border-border border-b px-4 py-1.5 text-muted-foreground text-xs"
        >
          {t("Searching:")} {global ? t("All projects") : (projectName ?? t("Current project"))}
          <span className="ms-2 opacity-70">
            {global ? t("Tab to search in current project") : t("Tab to search in all projects")}
          </span>
        </div>
        {!global && searchQuery.data?.partial && (
          <div
            data-testid="quick-open-partial"
            role="status"
            className="border-border border-b px-4 py-2 text-amber-500 text-xs"
          >
            {t("Some folders could not be searched:")} {searchQuery.data.skipped.join(", ")}
          </div>
        )}
        {!global && searchQuery.isError && (
          <div
            data-testid="quick-open-error"
            role="alert"
            className="border-border border-b px-4 py-2 text-destructive text-xs"
          >
            {t("File search failed:")} {searchQuery.error.message}
          </div>
        )}
        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {global ? (
            globalProjects.length === 0 ? (
              <li
                data-testid="quick-open-empty"
                className="px-4 py-2 text-muted-foreground/70 text-xs"
              >
                {t("No projects yet")}
              </li>
            ) : (
              globalProjects.map((project, index) => (
                <li key={project.id}>
                  <button
                    type="button"
                    data-testid="quick-open-project-result"
                    data-project-id={project.id}
                    data-highlighted={index === highlight}
                    onClick={() => choose(index)}
                    onMouseEnter={() => setHighlight(index)}
                    className={
                      index === highlight
                        ? "flex w-full items-center gap-2 bg-accent px-4 py-1.5 text-start text-foreground text-xs"
                        : "flex w-full items-center gap-2 px-4 py-1.5 text-start text-muted-foreground text-xs hover:bg-accent/60"
                    }
                  >
                    <FolderGit2 className="size-3.5 shrink-0 opacity-70" />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {project.name}
                    </span>
                    <span className="truncate text-muted-foreground/70">{project.repoPath}</span>
                  </button>
                </li>
              ))
            )
          ) : hits.length === 0 ? (
            <li
              data-testid="quick-open-empty"
              className="px-4 py-2 text-muted-foreground/70 text-xs"
            >
              {debounced.trim().length === 0 ? t("Type to search files") : t("No matching files")}
            </li>
          ) : (
            hits.map((hit, index) => (
              <li key={hit.relPath}>
                <button
                  type="button"
                  data-testid="quick-open-result"
                  data-rel-path={hit.relPath}
                  data-feature-label={hit.relPath}
                  data-feature-help={t("Open this project file in the built-in editor")}
                  data-highlighted={index === highlight}
                  onClick={() => choose(index)}
                  onMouseEnter={() => setHighlight(index)}
                  className={
                    index === highlight
                      ? "flex w-full items-center gap-2 bg-accent px-4 py-1.5 text-start text-foreground text-xs"
                      : "flex w-full items-center gap-2 px-4 py-1.5 text-start text-muted-foreground text-xs hover:bg-accent/60"
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
