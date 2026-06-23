import { ALL_DATA_FILE_KINDS, DATA_FILE_KIND_LABELS, type DataFileKind } from "@skipper/shared"
import { badgeVariants, cn, Input } from "@skipper/ui"
import { useQuery } from "@tanstack/react-query"
import { ChartArea, FileText, Search } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import type { DataFileEntry } from "../../../../../../main/trpc/science/analysis"
import { useTRPC } from "../../../../../trpc/react"
import { ScienceTabShell } from "../ScienceTabShell"
import { AnalysisPreview } from "./components/AnalysisPreview"

/**
 * Analysis science tab (AGENTS.md §1 "Science tabs", P8c) — a **read-only data
 * browser**: pick a project, browse the data/analysis files discovered in its
 * repo (grouped by kind, filtered by a search box), and preview a selected file
 * in a side pane. CSV/TSV render as a sampled table, images inline, JSON pretty-
 * printed, text as a head; everything else shows a metadata card. Interactive
 * charting/plotting is deliberately out of v1 scope.
 *
 * The project defaults to the most-recently-opened (`projects.list` is ordered
 * that way), with a selector to switch. The two columns each own their own
 * scroll per §12.3.
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
  const [kindFilter, setKindFilter] = useState<DataFileKind | "all">("all")
  const [selectedRelPath, setSelectedRelPath] = useState<string | null>(null)

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

  const kindsPresent = useMemo(() => {
    const set = new Set<DataFileKind>(allFiles.map((f) => f.kind))
    return ALL_DATA_FILE_KINDS.filter((k) => set.has(k))
  }, [allFiles])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return allFiles.filter((file) => {
      if (kindFilter !== "all" && file.kind !== kindFilter) return false
      if (needle && !file.relPath.toLowerCase().includes(needle)) return false
      return true
    })
  }, [allFiles, query, kindFilter])

  // Re-group the filtered files in canonical kind order for sectioned rendering.
  const filteredGroups = useMemo(() => {
    const byKind = new Map<DataFileKind, DataFileEntry[]>()
    for (const file of filtered) {
      const bucket = byKind.get(file.kind)
      if (bucket) bucket.push(file)
      else byKind.set(file.kind, [file])
    }
    return ALL_DATA_FILE_KINDS.filter((k) => byKind.has(k)).map((kind) => ({
      kind,
      files: byKind.get(kind) ?? [],
    }))
  }, [filtered])

  const selector =
    projects.length > 0 ? (
      <select
        data-testid="analysis-project-select"
        value={selectedProjectId ?? ""}
        onChange={(event) => setSelectedProjectId(event.target.value)}
        className="h-8 rounded-md border border-border bg-background px-2 text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    ) : null

  return (
    <ScienceTabShell
      testId="science-analysis"
      title="Analysis"
      subtitle="Browse and preview the data files in a project's repo"
      actions={selector}
    >
      {projects.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <NoProjectsState />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Left column: search + kind filter + grouped file list. */}
          <div className="flex w-80 shrink-0 flex-col border-border border-r">
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
              {kindsPresent.length > 0 ? (
                <div className="flex flex-wrap gap-1" data-testid="analysis-kind-filters">
                  <KindChip
                    label="All"
                    active={kindFilter === "all"}
                    onClick={() => setKindFilter("all")}
                    testId="analysis-kind-all"
                  />
                  {kindsPresent.map((kind) => (
                    <KindChip
                      key={kind}
                      label={DATA_FILE_KIND_LABELS[kind]}
                      active={kindFilter === kind}
                      onClick={() => setKindFilter(kind)}
                      testId={`analysis-kind-${kind}`}
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
                    <div key={group.kind} className="flex flex-col gap-1">
                      <div className="flex items-center gap-2 px-1">
                        <span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
                          {DATA_FILE_KIND_LABELS[group.kind]}
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

/** A clickable filter chip for a kind (or "All"). */
function KindChip({
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
            Analysis lists CSV/TSV, JSON, images, notebooks, and other data files discovered in the
            project's repo.
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
