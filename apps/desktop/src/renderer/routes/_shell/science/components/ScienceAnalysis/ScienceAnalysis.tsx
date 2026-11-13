import {
  ALL_DATA_FILE_CATEGORIES,
  ALL_DATA_FILE_KINDS,
  categoryOf,
  DATA_FILE_CATEGORY_LABELS,
  DATA_FILE_KIND_LABELS,
  type DataFileCategory,
  type DataFileKind,
} from "@pi-lab/shared/analysis/file-kind"
import { fuzzyMatch, highlightSegments } from "@pi-lab/shared/search/fuzzy"
import { badgeVariants, cn, Input } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { ChartArea, CloudDownload, FileCode2, FileText, Microscope, Search } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { DataFileEntry } from "../../../../../../main/trpc/science/analysis"
import { EdgeResizeHandle } from "../../../../../components/EdgeResizeHandle"
import {
  HeaderShortcuts,
  headerIconButtonClass,
} from "../../../../../components/HeaderShortcuts/HeaderShortcuts"
import { ProjectWorkflowControl } from "../../../../../components/ProjectWorkflow"
import { useTranslate } from "../../../../../i18n/language"
import {
  ANALYSIS_FILES_MAX_WIDTH,
  ANALYSIS_FILES_MIN_WIDTH,
  DEFAULT_RESULTS_FOLDER,
  useAnalysisFilesWidth,
  useAnalysisProject,
  useDefaultResultsFolder,
  useFetchExperimentsInstructions,
  useSciencePanelWidth,
} from "../../../../../preferences/preferences"
import { QuickFind, type QuickFindItem } from "../../../../../QuickFind"
import { eventMatchesShortcut } from "../../../../../shortcuts/shortcuts"
import { useTRPC } from "../../../../../trpc/react"
import { ProjectPicker } from "../ProjectPicker"
import {
  type FocusSessionRequest,
  SciencePanelCollapsedBar,
  SciencePanelDiaryButton,
  ScienceSessionPanel,
  type ScienceSessionRequest,
  useFocusSessionRequest,
  useSciencePanel,
  useSciencePanelRow,
} from "../ScienceSessionPanel"
import {
  ANALYSIS_FILES_DRAWN_MIN_WIDTH,
  ANALYSIS_PREVIEW_MIN_WIDTH,
  ANALYSIS_PREVIEW_PREFERRED_WIDTH,
  PANEL_DRAWN_MIN_WIDTH,
} from "../ScienceSessionPanel/panelFit"
import { ScienceTabShell } from "../ScienceTabShell"
import { AnalysisPreview } from "./components/AnalysisPreview"

/** The preview column's smallest width in px, beside the resizable file list. */

/**
 * Analysis science tab — a **read-only data
 * browser**: pick a project, browse the data/analysis files in its results
 * folder (`results/` by default, set in Settings; each project can choose its
 * own above the search). Each folder inside it is one experiment, and the list
 * is grouped by experiment, filtered by a search box and the category chips.
 * Preview a selected
 * file in a side pane. CSV/TSV render as a sampled table (or a line chart when
 * they look like a metric log), NumPy arrays as a chart (1-D) or grid (2-D),
 * images inline, JSON pretty-printed, text as a head; everything else shows a
 * metadata card.
 *
 * Top-level filter chips are coarse {@link DataFileCategory}s (Data, Images, …);
 * selecting a category that spans more than one sub-format reveals a second row
 * of sub-format bubbles (e.g. CSV / NumPy under Data) to narrow further.
 *
 * A project picker in the top bar remembers the last project; `initialProjectId`
 * (from `?projectId=`) selects one and becomes the remembered one, and the picker
 * always wins afterwards. With no usable choice it falls back to the
 * most-recently-opened project (`projects.list` is ordered that way). The two
 * columns each own their own scroll.
 */
export function ScienceAnalysis({
  initialProjectId,
  focusSession,
}: {
  initialProjectId?: string
  /** An agent session of the initial project to open and focus in the session panel, or null. */
  focusSession: FocusSessionRequest | null
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data])

  const [savedProjectId, setSavedProjectId] = useAnalysisProject()
  const navigate = useNavigate()
  // The picker remembers the choice and replaces the address.
  const chooseProject = (projectId: string): void => {
    setSavedProjectId(projectId)
    void navigate({ to: "/science/analysis", search: { projectId }, replace: true })
  }
  // A project given in the address wins and becomes the remembered one.
  useEffect(() => {
    if (initialProjectId) setSavedProjectId(initialProjectId)
  }, [initialProjectId, setSavedProjectId])
  const wanted = initialProjectId ?? savedProjectId
  // An unknown or missing choice falls back to the most-recently-opened project.
  const selectedProject = projects.find((project) => project.id === wanted) ?? projects[0]
  const selectedProjectId = selectedProject?.id ?? null
  const [fetchInstructions] = useFetchExperimentsInstructions()
  const userPanel = useSciencePanel("analysis")
  const [savedFilesWidth, persistFilesWidth] = useAnalysisFilesWidth()
  const [filesWidth, setFilesWidth] = useState(savedFilesWidth)
  useEffect(() => setFilesWidth(savedFilesWidth), [savedFilesWidth])
  // The file list, preview and right panel fit the row's width (no horizontal scroll).
  const row = useSciencePanelRow(
    userPanel,
    useSciencePanelWidth(),
    PANEL_DRAWN_MIN_WIDTH,
    projects.length === 0 ? null : { wanted: filesWidth, min: ANALYSIS_FILES_DRAWN_MIN_WIDTH },
    { preferred: ANALYSIS_PREVIEW_PREFERRED_WIDTH, min: ANALYSIS_PREVIEW_MIN_WIDTH },
  )
  const panel = row.panel
  const drawnFilesWidth = row.fit.side
  const capabilities = useQuery({
    ...trpc.projects.capabilities.queryOptions({ id: selectedProject?.id ?? "" }),
    enabled: Boolean(selectedProject),
  })
  const gitAvailable = capabilities.data?.git === true
  const gitDisabledReason = capabilities.isError
    ? `${t("Could not check Git availability: ")}${capabilities.error.message}`
    : capabilities.isPending
      ? t("Checking Git availability…")
      : t("Initialize Git to run Git-state-aware project routines.")

  const [query, setQuery] = useState("")
  // Top-level filter is a category; an optional sub-kind narrows within it.
  const [categoryFilter, setCategoryFilter] = useState<DataFileCategory | "all">("all")
  const [kindFilter, setKindFilter] = useState<DataFileKind | null>(null)
  const [selectedRelPath, setSelectedRelPath] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  // A session a top bar button started, until the session panel opens it.
  const [sessionRequest, setSessionRequest] = useState<ScienceSessionRequest | null>(null)
  const clearSessionRequest = useCallback(() => setSessionRequest(null), [])
  useFocusSessionRequest(initialProjectId, focusSession, setSessionRequest)
  const [shortcutError, setShortcutError] = useState<string | null>(null)
  // Analyze experiments follows the new-session setting (Settings > Shortcuts), which
  // opens a terminal agent by default. When it is set to "Terminal", the project's
  // agent still starts, since a skill needs an agent to run it.
  const analyzeExperiments = useMutation(
    trpc.sessions.startAnalyzeExperiments.mutationOptions({
      onSuccess: (result, input) =>
        setSessionRequest({
          projectId: input.projectId,
          pane: {
            kind: "agent",
            sessionId: result.sessionId,
            label: t("Analyze experiments"),
            wsKind: result.kind,
            launch: { type: "agent", agentId: result.agentId, workspaceMode: "policy" },
          },
        }),
      onError: (cause) => setShortcutError(cause.message),
    }),
  )
  // Report starts the project's agent with the report skill named in Settings.
  const report = useMutation(
    trpc.sessions.startReport.mutationOptions({
      onSuccess: (result, input) =>
        setSessionRequest({
          projectId: input.projectId,
          pane: {
            kind: "agent",
            sessionId: result.sessionId,
            label: t("Report"),
            wsKind: result.kind,
            launch: { type: "agent", agentId: result.agentId, workspaceMode: "policy" },
          },
        }),
      onError: (cause) => setShortcutError(cause.message),
    }),
  )
  // The default results folder from Settings; an empty field means the built-in default.
  const [defaultResultsFolderSetting] = useDefaultResultsFolder()
  const defaultResultsFolder = defaultResultsFolderSetting.trim() || DEFAULT_RESULTS_FOLDER
  const listing = useQuery({
    ...trpc.science.analysis.listFiles.queryOptions({
      projectId: selectedProjectId ?? "",
      defaultResultsFolder,
    }),
    enabled: selectedProjectId !== null,
    staleTime: 30_000,
  })
  const resultsMissing = listing.data?.exists === false

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
  // the sole ⌘F owner here). The finder runs its own filter independently.
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
    const needle = query.trim()
    const ranked: RankedAnalysisFile[] = []
    for (const file of allFiles) {
      if (categoryFilter !== "all" && categoryOf(file.kind) !== categoryFilter) continue
      if (kindFilter !== null && file.kind !== kindFilter) continue

      const nameMatch = fuzzyMatch(needle, file.name)
      const pathMatch = fuzzyMatch(needle, file.relPath)
      if (nameMatch === null && pathMatch === null) continue
      ranked.push({
        file,
        fuzzyScore: Math.max(nameMatch?.score ?? -1, pathMatch?.score ?? -1),
        likelihood: analysisLikelihood(file.relPath),
        namePositions: nameMatch?.positions ?? [],
        // When the basename already carries the match, highlighting it again in
        // the path is visual noise; directory-only matches remain visible here.
        pathPositions: nameMatch === null ? (pathMatch?.positions ?? []) : [],
      })
    }
    ranked.sort(
      (a, b) =>
        b.fuzzyScore - a.fuzzyScore ||
        b.likelihood - a.likelihood ||
        a.file.relPath.localeCompare(b.file.relPath),
    )
    return ranked
  }, [allFiles, query, categoryFilter, kindFilter])

  // Re-group the filtered files by experiment (the folder inside the results
  // folder), sorted by name, with "No experiment" (files directly in the
  // results folder) last. Files of the project's reports/ folder form their own
  // group after these. Within a group the ranking order is kept.
  const filteredGroups = useMemo(() => {
    const byExperiment = new Map<string | null, RankedAnalysisFile[]>()
    for (const rankedFile of filtered) {
      if (rankedFile.file.inReportsFolder) continue
      const experiment = rankedFile.file.experiment
      const bucket = byExperiment.get(experiment)
      if (bucket) bucket.push(rankedFile)
      else byExperiment.set(experiment, [rankedFile])
    }
    const named = [...byExperiment.keys()]
      .filter((experiment): experiment is string => experiment !== null)
      .sort((a, b) => a.localeCompare(b))
    const order: Array<string | null> = byExperiment.has(null) ? [...named, null] : named
    return order.map((experiment) => ({ experiment, files: byExperiment.get(experiment) ?? [] }))
  }, [filtered])
  const filteredReports = useMemo(
    () => filtered.filter((rankedFile) => rankedFile.file.inReportsFolder),
    [filtered],
  )
  const fileRows = (files: RankedAnalysisFile[]) =>
    files.map((rankedFile) => (
      <FileRow
        key={rankedFile.file.relPath}
        file={rankedFile.file}
        namePositions={rankedFile.namePositions}
        pathPositions={rankedFile.pathPositions}
        selected={rankedFile.file.relPath === selectedRelPath}
        onSelect={() => setSelectedRelPath(rankedFile.file.relPath)}
      />
    ))

  // Selecting a category clears any narrower sub-kind; "All" clears both.
  const selectCategory = (category: DataFileCategory | "all") => {
    setCategoryFilter(category)
    setKindFilter(null)
  }

  return (
    <ScienceTabShell
      layout="cards"
      testId="science-analysis"
      title={t("Analysis")}
      subtitle={t("Browse and preview the data files in a project's repo")}
      actions={
        <>
          <HeaderShortcuts
            view="analysis"
            projectId={selectedProjectId}
            picker={
              <ProjectPicker
                testId="analysis-project-select"
                label={t("Analysis project")}
                help={t("Choose which project repository to scan for data files.")}
                value={selectedProjectId ?? ""}
                projects={projects}
                allLabel={null}
                onChange={chooseProject}
              />
            }
            onError={setShortcutError}
            onSkillSessionStarted={(session) =>
              selectedProjectId
                ? setSessionRequest({
                    projectId: selectedProjectId,
                    pane: {
                      kind: "agent",
                      sessionId: session.sessionId,
                      label: session.label,
                      wsKind: session.kind,
                      launch: { type: "agent", agentId: session.agentId, workspaceMode: "policy" },
                    },
                  })
                : undefined
            }
            builtins={[
              {
                id: "analyze-experiments",
                label: t("Analyze experiments"),
                node: (
                  <button
                    type="button"
                    data-testid="analysis-analyze-experiments"
                    disabled={!selectedProjectId || analyzeExperiments.isPending}
                    aria-label={t("Analyze experiments")}
                    data-feature-label={t("Analyze experiments")}
                    title={selectedProjectId ? t("Analyze experiments") : t("Select a project")}
                    data-feature-help={t(
                      "Start an agent that summarises what each experiment shows",
                    )}
                    onClick={() => {
                      if (!selectedProjectId) return
                      setShortcutError(null)
                      analyzeExperiments.mutate({ projectId: selectedProjectId })
                    }}
                    className={headerIconButtonClass}
                  >
                    <Microscope className="size-3.5 shrink-0" aria-hidden />
                  </button>
                ),
              },
              {
                id: "report",
                label: t("Report"),
                node: (
                  <button
                    type="button"
                    data-testid="analysis-report"
                    disabled={!selectedProjectId || report.isPending}
                    aria-label={t("Report")}
                    title={t("Report")}
                    data-feature-label={t("Report")}
                    data-feature-help={
                      selectedProjectId
                        ? t(
                            "Start an agent that builds a report with the report skill set in Settings",
                          )
                        : t("Select a project")
                    }
                    onClick={() => {
                      if (!selectedProjectId) return
                      setShortcutError(null)
                      report.mutate({ projectId: selectedProjectId })
                    }}
                    className={headerIconButtonClass}
                  >
                    <FileCode2 className="size-3.5 shrink-0" aria-hidden />
                  </button>
                ),
              },
              {
                id: "fetch-experiments",
                label: t("Fetch experiments"),
                node: selectedProject ? (
                  <ProjectWorkflowControl
                    key={selectedProject.id}
                    projectId={selectedProject.id}
                    projectName={selectedProject.name}
                    task="fetch-experiments"
                    variant="icon"
                    testId="analysis-fetch-experiments"
                    instructions={fetchInstructions}
                    disabled={!gitAvailable}
                    disabledReason={!gitAvailable ? gitDisabledReason : undefined}
                  />
                ) : (
                  <button
                    type="button"
                    data-testid="analysis-fetch-experiments"
                    disabled
                    aria-label={t("Fetch experiments")}
                    title={t("Select a project")}
                    data-feature-label={t("Fetch experiments")}
                    className={headerIconButtonClass}
                  >
                    <CloudDownload className="size-3.5 shrink-0" aria-hidden />
                  </button>
                ),
              },
              {
                id: "research-diary",
                label: t("Research diary"),
                node: (
                  <SciencePanelDiaryButton
                    testId="analysis-research-diary"
                    panel={panel}
                    disabled={!selectedProjectId}
                  />
                ),
              },
            ]}
          />
          {shortcutError ? (
            <span
              role="alert"
              data-testid="analysis-shortcut-error"
              title={shortcutError}
              className="max-w-56 cursor-text select-text truncate text-destructive text-xs"
            >
              {shortcutError}
            </span>
          ) : null}
        </>
      }
    >
      {/* Each column is its own rounded card, 12px apart, like the project view. They fit
          the row's width: when it runs short the right panel narrows first, then the file
          list, then the preview, and then the right panel is drawn collapsed. */}
      <div ref={row.rowRef} className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {projects.length === 0 ? (
            <div className="relative min-h-0 flex-1 overflow-y-auto p-3">
              <NoProjectsState />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 gap-3">
              {/* Left card: search + category filter + file list, resizable from the gap on its right. */}
              <div
                data-testid="analysis-files-column"
                className="relative flex min-h-0 shrink-0"
                style={{ width: drawnFilesWidth }}
              >
                <EdgeResizeHandle
                  side="right"
                  width={drawnFilesWidth}
                  onResize={setFilesWidth}
                  onResizeEnd={persistFilesWidth}
                  min={ANALYSIS_FILES_MIN_WIDTH}
                  max={ANALYSIS_FILES_MAX_WIDTH}
                  testId="analysis-files-edge-drag"
                />
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-panel-border">
                  <div className="flex shrink-0 flex-col gap-2 border-border border-b px-4 py-2">
                    {selectedProjectId ? (
                      <ResultsFolderField
                        key={selectedProjectId}
                        projectId={selectedProjectId}
                        resultsFolder={listing.data?.resultsFolder ?? null}
                        overridden={listing.data?.overridden === true}
                      />
                    ) : null}
                    <div className="relative">
                      <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
                      <Input
                        data-testid="analysis-search"
                        aria-label={t("Search data files")}
                        data-feature-label={t("Search data files")}
                        data-feature-help={t(
                          "Filter this project's discovered data files by name or path.",
                        )}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("Search files…")}
                        className="h-8 pl-8"
                        disabled={allFiles.length === 0}
                      />
                    </div>
                    {categoriesPresent.length > 0 ? (
                      <div className="flex flex-wrap gap-1" data-testid="analysis-category-filters">
                        <FilterChip
                          label={t("All")}
                          active={categoryFilter === "all"}
                          onClick={() => selectCategory("all")}
                          testId="analysis-category-all"
                        />
                        {categoriesPresent.map((category) => (
                          <FilterChip
                            key={category}
                            label={t(DATA_FILE_CATEGORY_LABELS[category])}
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
                          label={t("All")}
                          active={kindFilter === null}
                          onClick={() => setKindFilter(null)}
                          testId="analysis-subkind-all"
                        />
                        {subKindsPresent.map((kind) => (
                          <FilterChip
                            key={kind}
                            label={t(DATA_FILE_KIND_LABELS[kind])}
                            active={kindFilter === kind}
                            onClick={() => setKindFilter(kind)}
                            testId={`analysis-subkind-${kind}`}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {listing.data?.partial ? (
                      <p
                        data-testid="analysis-partial"
                        role="status"
                        className="m-3 rounded border border-amber-500/40 px-2 py-1 text-amber-600 text-xs"
                        title={listing.data.skipped.join("\n")}
                      >
                        {t("Some project paths could not be read")} ({listing.data.skipped.length}).
                      </p>
                    ) : null}
                    {listing.isError ? (
                      <p
                        data-testid="analysis-list-error"
                        role="alert"
                        className="p-4 text-destructive text-xs"
                      >
                        {t("Could not read project data files:")} {listing.error.message}
                      </p>
                    ) : resultsMissing && allFiles.length === 0 ? null : allFiles.length === 0 &&
                      !listing.isLoading ? (
                      <EmptyState />
                    ) : (
                      <div className="flex flex-col gap-3 p-3">
                        {resultsMissing ? (
                          <p
                            data-testid="analysis-results-missing"
                            className="rounded border border-border border-dashed px-2 py-1.5 text-muted-foreground text-xs"
                          >
                            {t("No {folder} folder in this project").replace(
                              "{folder}",
                              `${listing.data?.resultsFolder ?? ""}/`,
                            )}
                          </p>
                        ) : null}
                        <div className="flex items-center justify-between px-1">
                          <span
                            data-testid="analysis-file-count"
                            className="font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
                          >
                            {filtered.length} {t("of")} {allFiles.length} {t("files")}
                          </span>
                          {listing.data?.truncated ? (
                            <span
                              data-testid="analysis-truncated"
                              className="text-[10px] text-amber-500"
                              title={t("The repo has more data files than are shown")}
                            >
                              {t("truncated")}
                            </span>
                          ) : null}
                        </div>

                        {filteredGroups.map((group) => (
                          <div
                            key={group.experiment ?? ""}
                            data-testid="analysis-experiment-group"
                            data-experiment={group.experiment ?? ""}
                            className="flex flex-col gap-1"
                          >
                            <div className="flex items-center gap-2 px-1">
                              <span
                                className="truncate font-medium text-[10px] text-muted-foreground uppercase tracking-wider"
                                title={group.experiment ?? undefined}
                              >
                                {group.experiment ?? t("No experiment")}
                              </span>
                              <span className="text-[10px] text-muted-foreground/50">
                                {group.files.length}
                              </span>
                            </div>
                            {fileRows(group.files)}
                          </div>
                        ))}

                        {filteredReports.length > 0 ? (
                          <div data-testid="analysis-reports-group" className="flex flex-col gap-1">
                            <div className="flex items-center gap-2 px-1">
                              <span className="truncate font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
                                {t("Reports (reports/)")}
                              </span>
                              <span className="text-[10px] text-muted-foreground/50">
                                {filteredReports.length}
                              </span>
                            </div>
                            {fileRows(filteredReports)}
                          </div>
                        ) : null}

                        {filtered.length === 0 && allFiles.length > 0 ? (
                          <p
                            data-testid="analysis-no-matches"
                            className="px-1 text-muted-foreground text-xs"
                          >
                            {t("No files match the current filter.")}
                          </p>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Middle card: preview pane for the selected file. */}
              <div
                data-testid="analysis-preview-column"
                className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-panel-border"
              >
                {selectedProjectId && selectedRelPath ? (
                  <AnalysisPreview
                    projectId={selectedProjectId}
                    relPath={selectedRelPath}
                    kind={
                      allFiles.find((file) => file.relPath === selectedRelPath)?.kind ?? "other"
                    }
                    onOpenNotebook={(notebookRelPath) =>
                      setSessionRequest({ projectId: selectedProjectId, notebookRelPath })
                    }
                    headerEnd={null}
                  />
                ) : resultsMissing && allFiles.length === 0 && !listing.isError ? (
                  <ResultsMissingState resultsFolder={listing.data?.resultsFolder ?? ""} />
                ) : (
                  <div className="relative h-full min-h-0">
                    <NoSelectionState />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <SciencePanelCollapsedBar testId="analysis-collapsed-bar" panel={panel} />
        <ScienceSessionPanel
          view="analysis"
          project={selectedProject ? { id: selectedProject.id, name: selectedProject.name } : null}
          panel={panel}
          width={row.width}
          openSession={sessionRequest}
          onSessionOpened={clearSessionRequest}
        />
      </div>

      {findOpen ? (
        <QuickFind
          ariaLabel={t("Find a file")}
          placeholder={t("Find a file…")}
          scopeLabel={t("Selected project files")}
          allowGlobalSearch
          items={findItems}
          emptyText={t("No matching files")}
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
  namePositions,
  pathPositions,
  selected,
  onSelect,
}: {
  file: DataFileEntry
  namePositions: number[]
  pathPositions: number[]
  selected: boolean
  onSelect: () => void
}) {
  const t = useTranslate()
  return (
    <button
      type="button"
      data-testid="analysis-file"
      data-rel-path={file.relPath}
      data-kind={file.kind}
      aria-pressed={selected}
      data-feature-label={file.name}
      data-feature-help={t("Open a read-only preview of this repository data file.")}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
      )}
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium" title={file.relPath}>
          <HighlightedText text={file.name} positions={namePositions} />
        </span>
        {file.relPath !== file.name ? (
          <span className="truncate text-[10px] text-muted-foreground" title={file.relPath}>
            <HighlightedText text={file.relPath} positions={pathPositions} />
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground/70">{formatSize(file.size)}</span>
    </button>
  )
}

interface RankedAnalysisFile {
  file: DataFileEntry
  fuzzyScore: number
  likelihood: number
  namePositions: number[]
  pathPositions: number[]
}

const LIKELY_ANALYSIS_TERMS = new Set([
  "analysis",
  "artifact",
  "artifacts",
  "eval",
  "evaluation",
  "experiment",
  "experiments",
  "figure",
  "figures",
  "metric",
  "metrics",
  "output",
  "outputs",
  "plot",
  "plots",
  "prediction",
  "predictions",
  "report",
  "reports",
  "result",
  "results",
  "run",
  "runs",
  "score",
  "scores",
  "summary",
])

const UNLIKELY_ANALYSIS_TERMS = new Set([
  "code",
  "config",
  "configs",
  "configuration",
  "fixture",
  "fixtures",
  "license",
  "package",
  "params",
  "parameters",
  "readme",
  "script",
  "scripts",
  "setup",
  "source",
  "src",
  "test",
  "tests",
])

/** Lightweight path/name prior; fuzzy relevance remains the primary sort key. */
function analysisLikelihood(relPath: string): number {
  const terms = relPath
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  let score = 0
  for (const term of terms) {
    if (LIKELY_ANALYSIS_TERMS.has(term)) score += 10
    if (UNLIKELY_ANALYSIS_TERMS.has(term)) score -= 10
  }
  return score
}

function HighlightedText({ text, positions }: { text: string; positions: number[] }) {
  let offset = 0
  return highlightSegments(text, positions).map((segment) => {
    const start = offset
    offset += segment.text.length
    return segment.matched ? (
      <mark
        key={`matched-${start}`}
        data-testid="analysis-match"
        className="bg-transparent font-semibold text-primary"
      >
        {segment.text}
      </mark>
    ) : (
      <span key={`plain-${start}`}>{segment.text}</span>
    )
  })
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
  const t = useTranslate()
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active}
      aria-pressed={active}
      data-feature-label={`${label} ${t("filter")}`}
      data-feature-help={t("Filter the data-file list by format or analysis category.")}
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
  const t = useTranslate()
  return (
    <div
      data-testid="science-analysis-no-projects"
      className="flex flex-col items-center gap-3 rounded-lg border border-border border-dashed p-12 text-center"
    >
      <ChartArea className="size-8 text-muted-foreground" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="font-medium text-foreground text-sm">{t("No projects open")}</p>
        <p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
          {t("Open a project from the sidebar to browse the data files in its repo.")}
        </p>
      </div>
    </div>
  )
}

/**
 * The results folder row above the file search: the folder Analysis lists,
 * "Change…" (folder picker; the router accepts only folders inside the
 * project and stores it for this project) and, when the project uses its own
 * folder, "Reset to default". A refused folder shows the reason.
 */
function ResultsFolderField({
  projectId,
  resultsFolder,
  overridden,
}: {
  projectId: string
  resultsFolder: string | null
  overridden: boolean
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const setResultsFolder = useMutation(
    trpc.science.analysis.setResultsFolder.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: trpc.science.analysis.listFiles.queryKey() }),
    }),
  )
  const pickDirectory = useMutation(trpc.system.pickDirectory.mutationOptions())
  const busy = setResultsFolder.isPending || pickDirectory.isPending
  const error = pickDirectory.error ?? setResultsFolder.error
  const change = (): void => {
    setResultsFolder.reset()
    pickDirectory.mutate(undefined, {
      onSuccess: (dir) => {
        if (dir) setResultsFolder.mutate({ projectId, dir })
      },
    })
  }
  const buttonClass =
    "shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
  return (
    <div data-testid="analysis-results-folder" className="flex flex-col gap-1">
      <span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
        {t("Results folder")}
      </span>
      <div className="flex items-center gap-1.5">
        <span
          data-testid="analysis-results-folder-path"
          className="min-w-0 flex-1 truncate font-mono text-xs"
          title={resultsFolder === null ? undefined : `${resultsFolder}/`}
        >
          {resultsFolder === null ? "" : `${resultsFolder}/`}
        </span>
        <button
          type="button"
          data-testid="analysis-results-folder-change"
          data-feature-label={t("Change results folder")}
          data-feature-help={t(
            "Choose a folder inside the project to list in Analysis. Each folder inside it is one experiment.",
          )}
          disabled={busy}
          onClick={change}
          className={buttonClass}
        >
          {t("Change…")}
        </button>
        {overridden ? (
          <button
            type="button"
            data-testid="analysis-results-folder-reset"
            data-feature-label={t("Reset to default")}
            data-feature-help={t("Use the default results folder from Settings again.")}
            disabled={busy}
            onClick={() => setResultsFolder.mutate({ projectId, dir: null })}
            className={buttonClass}
          >
            {t("Reset to default")}
          </button>
        ) : null}
      </div>
      {error ? (
        <p
          data-testid="analysis-results-folder-error"
          role="alert"
          className="text-destructive text-xs"
        >
          {error.message}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Shown in the preview card when the results folder does not exist in the selected
 * project and nothing else is listed; the file list card keeps the folder field.
 */
function ResultsMissingState({ resultsFolder }: { resultsFolder: string }) {
  const t = useTranslate()
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div
        data-testid="analysis-results-missing"
        className="flex flex-col items-center gap-3 rounded-lg border border-border border-dashed p-8 text-center"
      >
        <ChartArea className="size-8 text-muted-foreground" aria-hidden />
        <div className="flex flex-col gap-1">
          <p className="font-medium text-foreground text-sm">
            {t("No {folder} folder in this project").replace("{folder}", `${resultsFolder}/`)}
          </p>
          <p className="max-w-xs text-muted-foreground text-xs leading-relaxed">
            {t("Use Change… above to choose the folder that holds the experiment results.")}
          </p>
        </div>
      </div>
    </div>
  )
}

/** Shown when the selected project has no data/analysis files. */
function EmptyState() {
  const t = useTranslate()
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div
        data-testid="science-analysis-empty"
        className="flex flex-col items-center gap-3 rounded-lg border border-border border-dashed p-8 text-center"
      >
        <ChartArea className="size-8 text-muted-foreground" aria-hidden />
        <div className="flex flex-col gap-1">
          <p className="font-medium text-foreground text-sm">{t("No data files found")}</p>
          <p className="max-w-xs text-muted-foreground text-xs leading-relaxed">
            {t(
              "Analysis lists the data files, images, notebooks, and plots discovered in the project's repo.",
            )}
          </p>
        </div>
      </div>
    </div>
  )
}

/** Right-pane placeholder before a file is selected. */
function NoSelectionState() {
  const t = useTranslate()
  return (
    <div
      data-testid="analysis-no-selection"
      className="flex h-full items-center justify-center p-6 text-center"
    >
      <p className="max-w-xs text-muted-foreground text-sm">
        {t("Select a file to preview its contents.")}
      </p>
    </div>
  )
}
