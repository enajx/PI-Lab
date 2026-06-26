import {
  ALL_DATA_FILE_CATEGORIES,
  ALL_DATA_FILE_KINDS,
  categoryOf,
  DATA_FILE_CATEGORY_LABELS,
  DATA_FILE_KIND_LABELS,
  type DataFileCategory,
  type DataFileKind,
} from "@skipper/shared"
import { badgeVariants, cn, Input } from "@skipper/ui"
import { useQuery } from "@tanstack/react-query"
import { ChartArea, FileText, Search } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import type { DataFileEntry } from "../../../../../../main/trpc/science/analysis"
import { QuickFind, type QuickFindItem } from "../../../../../QuickFind"
import { eventMatchesShortcut } from "../../../../../shortcuts/shortcuts"
import { useTRPC } from "../../../../../trpc/react"
import { ScienceTabShell } from "../ScienceTabShell"
import { AnalysisPreview } from "./components/AnalysisPreview"

/**
 * Analysis science tab (AGENTS.md "Scope" "Science tabs", P8c) — a **read-only data
 * browser**: pick a project, browse the data/analysis files discovered in its
 * repo (grouped by category, filtered by a search box), and preview a selected
 * file in a side pane. CSV/TSV render as a sampled table (or a line chart when
 * they look like a metric log), NumPy arrays as a chart (1-D) or grid (2-D),
 * images inline, JSON pretty-printed, text as a head; everything else shows a
 * metadata card.
 *
 * Top-level filter chips are coarse {@link DataFileCategory}s (Data, Images, …);
 * selecting a category that spans more than one sub-format reveals a second row
 * of sub-format bubbles (e.g. CSV / NumPy under Data) to narrow further.
 *
 * The project defaults to the most-recently-opened (`projects.list` is ordered
 * that way), with a selector at the top of the left column. The two columns each
 * own their own scroll per AGENTS.md Pitfalls #3.
 */
export function ScienceAnalysis() {
  const trpc = useTRPC()

  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data])

  // Default to the most-recently-opened project (first in the ordered list) and
  // keep the selection valid as the project list loads / changes.
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  useEffect(() => {
    if (projects.length === 0) {
      if (selectedProjectId !== null) setSelectedProjectId(null)
      return
    }
    if (!selectedProjectId || !projects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(projects[0]?.id ?? null)
    }
  }, [projects, selectedProjectId])

  const [query, setQuery] = useState("")
  // Top-level filter is a category; an optional sub-kind narrows within it.
  const [categoryFilter, setCategoryFilter] = useState<DataFileCategory | "all">("all")
  const [kindFilter, setKindFilter] = useState<DataFileKind | null>(null)
  const [selectedRelPath, setSelectedRelPath] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)

  const listing = useQuery({
    ...trpc.science.analysis.listFiles.queryOptions({ projectId: selectedProjectId ?? "" }),
    enabled: selectedProjectId !== null,
    staleTime: 30_000,
  })

  // Flatten the grouped listing once; the UI re-groups after filtering.
  const allFiles = useMemo<DataFileEntry[]>(
    () => listing.data?.groups.flatMap((g) => g.files) ?? [],
    [listing.data],
  )

  // Reset the selection when the project changes / the file is gone.
  useEffect(() => {
    if (selectedRelPath && !allFiles.some((f) => f.relPath === selectedRelPath)) {
      setSelectedRelPath(null)
    }
  }, [allFiles, selectedRelPath])

  // Context-aware ⌘F: while Analysis is open, the quick-open shortcut opens a fuzzy
  // finder over this project's data files (the shell skips /science/* so this tab is
  // the sole ⌘F owner here). The finder runs its own filter — the inline substring box
  // stays independent.
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (eventMatchesShortcut(event, "quick-open")) {
        event.preventDefault()
        setFindOpen(true)
      }
    }
    window.addEventListener("keydown", onWindowKeyDown)
    return () => window.removeEventListener("keydown", onWindowKeyDown)
  }, [])

  // The full file list as quick-find items (intentionally not narrowed by the inline
  // substring box or category chips — QuickFind does its own fuzzy match). The label is
  // the basename; the hint is the containing directory, if any.
  const findItems = useMemo<QuickFindItem[]>(
    () =>
      allFiles.map((file) => {
        const slash = file.relPath.lastIndexOf("/")
        return {
          id: file.relPath,
          label: file.name,
          hint: slash >= 0 ? file.relPath.slice(0, slash) : undefined,
          icon: FileText,
        }
      }),
    [allFiles],
  )

  // Categories present, in canonical order (the top-level filter chips).
  const categoriesPresent = useMemo(() => {
    const set = new Set<DataFileCategory>(allFiles.map((f) => categoryOf(f.kind)))
    return ALL_DATA_FILE_CATEGORIES.filter((c) => set.has(c))
  }, [allFiles])

  // Sub-kinds present within the selected category, in canonical order. Only a
  // category with more than one is offered as a row of sub-format bubbles.
  const subKindsPresent = useMemo(() => {
    if (categoryFilter === "all") return []
    const set = new Set<DataFileKind>(
      allFiles.filter((f) => categoryOf(f.kind) === categoryFilter).map((f) => f.kind),
    )
    return ALL_DATA_FILE_KINDS.filter((k) => set.has(k))
  }, [allFiles, categoryFilter])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return allFiles.filter((file) => {
      if (categoryFilter !== "all" && categoryOf(file.kind) !== categoryFilter) return false
      if (kindFilter !== null && file.kind !== kindFilter) return false
      if (needle && !file.relPath.toLowerCase().includes(needle)) return false
      return true
    })
  }, [allFiles, query, categoryFilter, kindFilter])

  // Re-group the filtered files by category in canonical order for sectioned
  // rendering — the header reads "Data", not the raw sub-format.
  const filteredGroups = useMemo(() => {
    const byCategory = new Map<DataFileCategory, DataFileEntry[]>()
    for (const file of filtered) {
      const category = categoryOf(file.kind)
      const bucket = byCategory.get(category)
      if (bucket) bucket.push(file)
      else byCategory.set(category, [file])
    }
    return ALL_DATA_FILE_CATEGORIES.filter((c) => byCategory.has(c)).map((category) => ({
      category,
      files: byCategory.get(category) ?? [],
    }))
  }, [filtered])

  // Selecting a category clears any narrower sub-kind; "All" clears both.
  const selectCategory = (category: DataFileCategory | "all") => {
    setCategoryFilter(category)
    setKindFilter(null)
  }

  return (
    <ScienceTabShell
      testId="science-analysis"
      title="Analysis"
      subtitle="Browse and preview the data files in a project's repo"
    >
      {projects.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <NoProjectsState />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Left column: project selector + search + category filter + file list. */}
          <div className="flex w-80 shrink-0 flex-col border-border border-r">
            <div className="flex shrink-0 items-center border-border border-b px-4 py-2">
              <select
                data-testid="analysis-project-select"
                value={selectedProjectId ?? ""}
                onChange={(event) => setSelectedProjectId(event.target.value)}
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex shrink-0 flex-col gap-2 border-border border-b px-4 py-2">
              <div className="relative">
                <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
                <Input
                  data-testid="analysis-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search files…"
                  className="h-8 pl-8"
                  disabled={allFiles.length === 0}
                />
              </div>
              {categoriesPresent.length > 0 ? (
                <div className="flex flex-wrap gap-1" data-testid="analysis-category-filters">
                  <FilterChip
                    label="All"
                    active={categoryFilter === "all"}
                    onClick={() => selectCategory("all")}
                    testId="analysis-category-all"
                  />
                  {categoriesPresent.map((category) => (
                    <FilterChip
                      key={category}
                      label={DATA_FILE_CATEGORY_LABELS[category]}
                      active={categoryFilter === category}
                      onClick={() => selectCategory(category)}
                      testId={`analysis-category-${category}`}
                    />
                  ))}
                </div>
              ) : null}
              {subKindsPresent.length > 1 ? (
                <div className="flex flex-wrap gap-1" data-testid="analysis-subkind-filters">
                  <FilterChip
                    label="All"
                    active={kindFilter === null}
                    onClick={() => setKindFilter(null)}
                    testId="analysis-subkind-all"
                  />
                  {subKindsPresent.map((kind) => (
                    <FilterChip
                      key={kind}
                      label={DATA_FILE_KIND_LABELS[kind]}
                      active={kindFilter === kind}
                      onClick={() => setKindFilter(kind)}
                      testId={`analysis-subkind-${kind}`}
                    />
                  ))}
                </div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {allFiles.length === 0 && !listing.isLoading ? (
                <EmptyState />
              ) : (
                <div className="flex flex-col gap-3 p-3">
                  <div className="flex items-center justify-between px-1">
                    <span
                      data-testid="analysis-file-count"
                      className="font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
                    >
                      {filtered.length} of {allFiles.length} files
                    </span>
                    {listing.data?.truncated ? (
                      <span
                        data-testid="analysis-truncated"
                        className="text-[10px] text-amber-500"
                        title="The repo has more data files than are shown"
                      >
                        truncated
                      </span>
                    ) : null}
                  </div>

                  {filteredGroups.map((group) => (
                    <div key={group.category} className="flex flex-col gap-1">
                      <div className="flex items-center gap-2 px-1">
                        <span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
                          {DATA_FILE_CATEGORY_LABELS[group.category]}
                        </span>
                        <span className="text-[10px] text-muted-foreground/50">
                          {group.files.length}
                        </span>
                      </div>
                      {group.files.map((file) => (
                        <FileRow
                          key={file.relPath}
                          file={file}
                          selected={file.relPath === selectedRelPath}
                          onSelect={() => setSelectedRelPath(file.relPath)}
                        />
                      ))}
                    </div>
                  ))}

                  {filtered.length === 0 && allFiles.length > 0 ? (
                    <p
                      data-testid="analysis-no-matches"
                      className="px-1 text-muted-foreground text-xs"
                    >
                      No files match the current filter.
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          </div>

          {/* Right column: preview pane for the selected file. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {selectedProjectId && selectedRelPath ? (
              <AnalysisPreview projectId={selectedProjectId} relPath={selectedRelPath} />
            ) : (
              <NoSelectionState />
            )}
          </div>
        </div>
      )}

      {findOpen ? (
        <QuickFind
          ariaLabel="Find a file"
          placeholder="Find a file…"
          items={findItems}
          emptyText="No matching files"
          onSelect={(item) => setSelectedRelPath(item.id)}
          onClose={() => setFindOpen(false)}
        />
      ) : null}
    </ScienceTabShell>
  )
}

/** A single file row in the list (icon, name, repo-relative path, size). */
function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: DataFileEntry
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-testid="analysis-file"
      data-rel-path={file.relPath}
      data-kind={file.kind}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
      )}
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium" title={file.relPath}>
          {file.name}
        </span>
        {file.relPath !== file.name ? (
          <span className="truncate text-[10px] text-muted-foreground" title={file.relPath}>
            {file.relPath}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground/70">{formatSize(file.size)}</span>
    </button>
  )
}

/** A clickable filter chip for a category, sub-kind, or "All". */
function FilterChip({
  label,
  active,
  onClick,
  testId,
}: {
  label: string
  active: boolean
  onClick: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        badgeVariants({ variant: active ? "default" : "muted" }),
        "cursor-pointer select-none",
      )}
    >
      {label}
    </button>
  )
}

/** Human-readable byte size (B / KB / MB). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Shown when no project is open at all (nothing to scan). */
function NoProjectsState() {
  return (
    <div
      data-testid="science-analysis-no-projects"
      className="flex flex-col items-center gap-3 rounded-lg border border-border border-dashed p-12 text-center"
    >
      <ChartArea className="size-8 text-muted-foreground" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="font-medium text-foreground text-sm">No projects open</p>
        <p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
          Open a project from the sidebar to browse the data files in its repo.
        </p>
      </div>
    </div>
  )
}

/** Shown when the selected project has no data/analysis files. */
function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div
        data-testid="science-analysis-empty"
        className="flex flex-col items-center gap-3 rounded-lg border border-border border-dashed p-8 text-center"
      >
        <ChartArea className="size-8 text-muted-foreground" aria-hidden />
        <div className="flex flex-col gap-1">
          <p className="font-medium text-foreground text-sm">No data files found</p>
          <p className="max-w-xs text-muted-foreground text-xs leading-relaxed">
            Analysis lists the data files, images, notebooks, and plots discovered in the project's
            repo.
          </p>
        </div>
      </div>
    </div>
  )
}

/** Right-pane placeholder before a file is selected. */
function NoSelectionState() {
  return (
    <div
      data-testid="analysis-no-selection"
      className="flex h-full items-center justify-center p-6 text-center"
    >
      <p className="max-w-xs text-muted-foreground text-sm">
        Select a file to preview its contents.
      </p>
    </div>
  )
}
