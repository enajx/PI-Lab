import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from "@pi-lab/local-db/editor-settings"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Link2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { EdgeResizeHandle } from "../../../../../components/EdgeResizeHandle"
import { headerIconButtonClass } from "../../../../../components/HeaderShortcuts/HeaderShortcuts"
import { usePopupDismiss } from "../../../../../components/usePopupDismiss"
import { useTranslate } from "../../../../../i18n/language"
import {
  RESEARCH_DIARY_MAX_WIDTH,
  RESEARCH_DIARY_MIN_WIDTH,
  useCurrentProject,
  useResearchDiaryWidth,
} from "../../../../../preferences/preferences"
import { useTRPC } from "../../../../../trpc/react"
import { useReportViewProject } from "../../../components/StatusBar/viewProjectStore"
import { setPendingOpenFile } from "../../../projects/-pendingOpenFile"
import { DIARY_TAB_ID } from "../../../projects/components/RightSidebar"
import { ProjectPicker } from "../ProjectPicker"
import {
  PanelExpandButton,
  ProjectDocumentsCard,
  SciencePanelDiaryButton,
  type SciencePanelState,
  type SciencePanelWidth,
  useSciencePanelRow,
} from "../ScienceSessionPanel"
import {
  LATEX_EDITOR_MIN_WIDTH,
  LATEX_EDITOR_PREFERRED_WIDTH,
} from "../ScienceSessionPanel/panelFit"
import { ScienceTabShell } from "../ScienceTabShell"
import { type FocusSessionRequest, PaperEditor } from "./PaperEditor"
import { MissingPaperFolder } from "./PaperFolder"
import { type CreatedPaper, PaperSetup } from "./PaperSetup"

/**
 * LaTeX Editor science tab: a project picker at the top (remembers the last
 * project; a project card can open it with a project chosen), then either the
 * setup to choose the project's paper folder or the paper workspace. With a
 * paper folder set, the workspace puts its Sync button next to the picker. A
 * saved paper folder that was moved or deleted shows a message with buttons to
 * choose it again or clear it instead. With no projects, or with New paper…
 * chosen in the picker, the setup cards add a paper with no project (a
 * paper-only project, then chosen); a paper-only project has a Link to
 * project button that moves its paper to a project with none. With the paper
 * workspace shown, the top bar has the "+" shortcut menu left of the picker and
 * the right of the page the project's documents column (not for a paper-only
 * project): the project view's right sidebar, with Research, TODOs, Files, Diary and
 * the pinned panels. It starts collapsed each time a paper is opened; its expand
 * button (at the right end of the editor card's toolbar) or the top bar diary button
 * (which opens it on the Diary tab) shows it, and its own collapse button hides it.
 * A file the Files tab opens opens in the project view.
 * `focusSession` focuses one agent tab of the initial project (see the Project
 * Agents box).
 */
export function ScienceLatex({
  initialProjectId,
  focusSession,
  newPaper,
}: {
  initialProjectId?: string
  /** True when New paper… was chosen (the `newPaper` address value): show the cards for a paper with no project. */
  newPaper: boolean
  /** An agent session of the initial project to focus, or null. */
  focusSession: FocusSessionRequest | null
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data])
  const [savedProjectId, setSavedProjectId] = useCurrentProject()
  const navigate = useNavigate()
  // The picker always wins over a project in the address: it makes the
  // choice current and replaces the address (dropping any agent to focus).
  // New paper… in the picker goes in the address, so opening any project afterwards clears it.
  const chooseProject = (projectId: string): void => {
    if (projectId === NEW_PAPER) {
      void navigate({ to: "/science/latex", search: { newPaper: true }, replace: true })
      return
    }
    setSavedProjectId(projectId)
    void navigate({ to: "/science/latex", search: { projectId }, replace: true })
  }

  // A project chosen from a dashboard card wins and becomes the current one.
  useEffect(() => {
    if (initialProjectId) setSavedProjectId(initialProjectId)
  }, [initialProjectId, setSavedProjectId])
  const wanted = initialProjectId ?? savedProjectId
  const selected = projects.find((project) => project.id === wanted) ?? projects[0] ?? null
  useReportViewProject(selected?.id ?? null)

  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const settings: EditorSettings = settingsQuery.data?.editor ?? DEFAULT_EDITOR_SETTINGS
  const updateEditor = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
      },
    }),
  )
  // The project whose Start draft is running: its setup stays shown until the
  // PDF is built, even if the paper state already has the new paper.
  const [creatingFor, setCreatingFor] = useState<string | null>(null)
  // The paper Start draft just made; its editor shows that build's PDF or failure.
  const [created, setCreated] = useState<CreatedPaper | null>(null)
  // The top bar element the paper workspace puts its Update paper and Sync buttons in.
  const [syncSlot, setSyncSlot] = useState<HTMLElement | null>(null)
  const paper = useQuery({
    ...trpc.paper.get.queryOptions({ projectId: selected?.id ?? "" }),
    enabled: selected !== null,
  })
  const standaloneSetup = newPaper || (projectsQuery.isSuccess && projects.length === 0)
  const paperOnly = !standaloneSetup && selected?.metadata?.paperOnly === true
  // The editor and the documents fit the row's width: the documents narrow first, then
  // the editor, and then the documents are drawn collapsed (see useSciencePanelRow).
  const diaryRow = useSciencePanelRow(
    useLatexDocumentsPanel(selected?.id ?? null),
    useResearchDiaryWidth(),
    RESEARCH_DIARY_MIN_WIDTH,
    null,
    { preferred: LATEX_EDITOR_PREFERRED_WIDTH, min: LATEX_EDITOR_MIN_WIDTH },
  )
  const diaryPanel = diaryRow.panel
  // The paper workspace puts the picker in its "+" shortcut row (in `syncSlot`).
  const editorShown =
    !projectsQuery.isError &&
    !standaloneSetup &&
    selected !== null &&
    !paper.isError &&
    paper.data !== undefined &&
    !paper.data.paper?.missing &&
    Boolean(paper.data.paper && paper.data.workspaceId) &&
    creatingFor !== selected.id

  const picker = (
    <>
      <ProjectPicker
        testId="latex-project-select"
        label={t("LaTeX Editor project")}
        help={null}
        value={standaloneSetup ? NEW_PAPER : (selected?.id ?? "")}
        projects={[
          ...projects.map((project) => ({ id: project.id, name: project.name })),
          { id: NEW_PAPER, name: t("New paper…") },
        ]}
        allLabel={null}
        onChange={chooseProject}
      />
      {paperOnly && selected ? (
        <LinkToProject
          paperProjectId={selected.id}
          projects={projects.filter(
            (project) => !project.metadata?.paper && !project.metadata?.paperOnly,
          )}
          onLinked={chooseProject}
        />
      ) : null}
    </>
  )

  return (
    <ScienceTabShell
      layout="cards"
      title={t("LaTeX Editor")}
      testId="science-latex"
      actions={
        editorShown ? (
          <div ref={setSyncSlot} data-testid="latex-sync-slot" className="contents" />
        ) : (
          picker
        )
      }
    >
      {updateEditor.isError ? (
        <p role="alert" className="cursor-text select-text px-1 text-destructive text-sm">
          {updateEditor.error.message}
        </p>
      ) : null}
      {projectsQuery.isError ? (
        <p role="alert" className="p-6 text-destructive text-sm">
          {projectsQuery.error.message}
        </p>
      ) : standaloneSetup ? (
        <PaperSetup
          key="new-paper"
          projectId={null}
          autoDetect={false}
          onCreateStart={() => undefined}
          onCreated={setCreated}
          onAdded={chooseProject}
        />
      ) : !selected ? (
        <p className="p-6 text-muted-foreground text-sm">
          {projectsQuery.isPending ? t("Loading…") : t("No open projects")}
        </p>
      ) : paper.isError ? (
        <p role="alert" className="cursor-text select-text p-6 text-destructive text-sm">
          {paper.error.message}
        </p>
      ) : paper.data === undefined ? null : paper.data.paper?.missing ? (
        <MissingPaperFolder key={selected.id} projectId={selected.id} dir={paper.data.paper.dir} />
      ) : paper.data.paper && paper.data.workspaceId && creatingFor !== selected.id ? (
        <div ref={diaryRow.rowRef} className="flex min-h-0 flex-1 gap-3 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            {paper.data.skippedFolders && paper.data.skippedFolders.length > 0 ? (
              <p
                data-testid="paper-skipped-folders"
                className="cursor-text select-text px-1 text-muted-foreground text-xs"
              >
                {t("Skipped folders that could not be read:")}{" "}
                {paper.data.skippedFolders.join(", ")}
              </p>
            ) : null}
            <PaperEditor
              key={paper.data.workspaceId}
              projectId={selected.id}
              projectName={selected.name}
              workspaceId={paper.data.workspaceId}
              paperDir={paper.data.paper.dir}
              displayDir={paper.data.paper.displayDir}
              rootRelPath={paper.data.rootRelPath}
              mainDoc={paper.data.mainDoc}
              texFiles={paper.data.texFiles}
              lastSyncAt={paper.data.paper.lastSyncAt}
              hasRemote={paper.data.paper.remoteUrl !== null}
              syncEnabled={paper.data.paper.syncEnabled}
              outputDir={paper.data.paper.outputDir}
              effectiveOutputDir={paper.data.paper.effectiveOutputDir}
              settings={settings}
              onUpdateEditorSettings={(patch) => updateEditor.mutate(patch)}
              focusSession={selected.id === initialProjectId ? focusSession : null}
              syncSlot={syncSlot}
              picker={picker}
              diaryButton={
                paperOnly ? null : (
                  <SciencePanelDiaryButton
                    testId="latex-research-diary"
                    panel={diaryPanel}
                    disabled={false}
                  />
                )
              }
              toolbarEnd={
                paperOnly || !diaryPanel.collapsed ? null : (
                  <PanelExpandButton
                    testId="latex-diary-expand"
                    label={t("Show documents")}
                    help={t("Show this project's documents: Research, TODOs, Files and Diary.")}
                    onClick={() => diaryPanel.setCollapsed(false)}
                  />
                )
              }
              createdBuild={
                created && created.workspaceId === paper.data.workspaceId ? created.build : null
              }
            />
          </div>
          {paperOnly ? null : (
            <LatexDocumentsColumn
              projectId={selected.id}
              panel={diaryPanel}
              width={diaryRow.width}
              onOpenFile={(relPath) => {
                setPendingOpenFile(selected.id, relPath)
                void navigate({ to: "/projects/$projectId", params: { projectId: selected.id } })
              }}
            />
          )}
        </div>
      ) : (
        <PaperSetup
          key={selected.id}
          projectId={selected.id}
          autoDetect={paper.data.autoDetect}
          onCreateStart={() => setCreatingFor(selected.id)}
          onCreated={(paper) => {
            setCreatingFor(null)
            setCreated(paper)
          }}
          onAdded={chooseProject}
        />
      )}
    </ScienceTabShell>
  )
}

/**
 * The LaTeX Editor's right panel state for the chosen project: the documents are
 * always on, and the panel starts collapsed each time a paper (project) is opened.
 * The top bar diary button opens it on the Diary tab, or while that shows, collapses it.
 */
function useLatexDocumentsPanel(projectId: string | null): SciencePanelState {
  // The project the panel was opened for; another project shows it collapsed.
  const [openFor, setOpenFor] = useState<string | null>(null)
  const [documentsTab, setDocumentsTab] = useState(DIARY_TAB_ID)
  const collapsed = projectId === null || openFor !== projectId
  const showDiary = (): void => {
    setOpenFor(projectId)
    setDocumentsTab(DIARY_TAB_ID)
  }
  return {
    collapsed,
    setCollapsed: (next) => setOpenFor(next ? null : projectId),
    documentsTab,
    setDocumentsTab,
    showDiary,
    toggleDiary: () => {
      if (!collapsed && documentsTab === DIARY_TAB_ID) setOpenFor(null)
      else showDiary()
    },
    tabVisibility: null,
  }
}

/**
 * The LaTeX Editor's right column: the project's documents (the project view's right
 * sidebar, its own rounded card), resizable from the gap on its left (the width is a
 * saved preference; it is drawn at `width.drawn`; dragging it below the minimum width
 * collapses it). The sidebar's collapse button collapses the column. Collapsed,
 * nothing is drawn: the button to show it again is at the right end of the editor
 * card's toolbar.
 */
function LatexDocumentsColumn({
  projectId,
  panel,
  width,
  onOpenFile,
}: {
  projectId: string
  panel: SciencePanelState
  width: SciencePanelWidth
  onOpenFile: (relPath: string) => void
}) {
  // Collapsed: nothing is drawn (an empty hidden column keeps its collapsed state
  // readable); the expand button is in the editor card's toolbar.
  if (panel.collapsed) return <aside data-testid="latex-diary" data-collapsed="true" hidden />
  return (
    <aside
      data-testid="latex-diary"
      data-collapsed="false"
      className="relative flex min-h-0 shrink-0 flex-col"
      style={{ width: width.drawn }}
    >
      <EdgeResizeHandle
        side="left"
        width={width.drawn}
        onResize={width.setWidth}
        onResizeEnd={width.persistWidth}
        min={RESEARCH_DIARY_MIN_WIDTH}
        max={RESEARCH_DIARY_MAX_WIDTH}
        onCollapse={() => panel.setCollapsed(true)}
        testId="research-diary-edge-drag"
      />
      <ProjectDocumentsCard
        key={projectId}
        projectId={projectId}
        activeId={panel.documentsTab}
        onActiveIdChange={panel.setDocumentsTab}
        onCollapse={() => panel.setCollapsed(true)}
        onOpenFile={onOpenFile}
        leadingTab={null}
        tabVisibility={null}
      />
    </aside>
  )
}

/** The picker entry that shows the setup cards for a paper with no project. */
const NEW_PAPER = "__new-paper__"

/**
 * Link to project, for a paper-only project: a menu of the projects with no
 * paper folder; choosing one moves the paper there (`paper.moveToProject`,
 * which removes the paper-only project) and opens that project.
 */
function LinkToProject({
  paperProjectId,
  projects,
  onLinked,
}: {
  paperProjectId: string
  projects: { id: string; name: string }[]
  onLinked: (projectId: string) => void
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  usePopupDismiss(open, [rootRef], () => setOpen(false))
  const move = useMutation(
    trpc.paper.moveToProject.mutationOptions({
      onSuccess: (_state, input) => {
        void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })
        void queryClient.invalidateQueries({ queryKey: trpc.paper.get.queryKey() })
        onLinked(input.toProjectId)
      },
    }),
  )
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="latex-link-to-project"
        aria-label={t("Link to project")}
        title={t("Link to project")}
        data-feature-help={t(
          "Move this paper to a project. The paper's own card is removed; its files stay where they are.",
        )}
        disabled={move.isPending}
        data-feature-label={t("Link to project")}
        onClick={() => setOpen((value) => !value)}
        className={headerIconButtonClass}
      >
        <Link2 className="size-3.5 shrink-0" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 min-w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground text-xs shadow-md"
        >
          {projects.length === 0 ? (
            <p className="px-2 py-1.5 text-muted-foreground">
              {t("Every project already has a paper folder.")}
            </p>
          ) : (
            projects.map((project) => (
              <button
                key={project.id}
                type="button"
                role="menuitem"
                className="flex w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => {
                  setOpen(false)
                  move.mutate({ fromProjectId: paperProjectId, toProjectId: project.id })
                }}
              >
                {project.name}
              </button>
            ))
          )}
        </div>
      ) : null}
      {move.isError ? (
        <p
          role="alert"
          className="absolute right-0 mt-1 w-72 cursor-text select-text rounded-md border border-destructive/30 bg-card p-2 text-destructive text-xs"
        >
          {move.error.message}
        </p>
      ) : null}
    </div>
  )
}
