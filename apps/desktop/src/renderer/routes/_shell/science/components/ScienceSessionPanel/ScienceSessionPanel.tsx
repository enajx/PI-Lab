import type { AgentSessionOrigin } from "@pi-lab/local-db"
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from "@pi-lab/local-db/editor-settings"
import { cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Bot,
  NotebookPen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react"
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { EdgeResizeHandle } from "../../../../../components/EdgeResizeHandle"
import { headerIconButtonClass } from "../../../../../components/HeaderShortcuts/HeaderShortcuts"
import type { OpenBuffer } from "../../../../../Editor/hooks/useEditorBuffers"
import type { RetainedBuffers } from "../../../../../Editor/hooks/useEditorBuffers/useEditorBuffers"
import { useTranslate } from "../../../../../i18n/language"
import {
  RESEARCH_DIARY_MAX_SHARE,
  RESEARCH_DIARY_MIN_SHARE,
  readRestoreProjectTabs,
  SCIENCE_PANEL_MAX_WIDTH,
  SCIENCE_PANEL_MIN_WIDTH,
  useResearchDiaryOpen,
  useResearchDiaryShare,
} from "../../../../../preferences/preferences"
import { overlayIsOpen } from "../../../../../shortcuts/keyGuards"
import { useTRPC, useTRPCClient } from "../../../../../trpc/react"
import { registerProjectEditor } from "../../../projects/-workspaceEditorOperations"
import {
  readProjectWorkspaceState,
  type SessionPanelView,
  sessionPanelWorkspaceKey,
  workspaceRecovery,
  writeProjectWorkspaceState,
} from "../../../projects/-workspaceState"
import { CentralPanel, useCentralPanel } from "../../../projects/components/CentralPanel"
import {
  useNewSessionShortcut,
  useOpenNewSession,
} from "../../../projects/components/CentralPanel/newSessionShortcut"
import type {
  CentralPanelRestoreState,
  SessionPane,
} from "../../../projects/components/CentralPanel/useCentralPanel"
import { DIARY_TAB_ID } from "../../../projects/components/RightSidebar"
import { ProjectDocumentsCard } from "./ProjectDocumentsCard"
import { fitPanelRow, type PanelRowFit, type PanelRowInput } from "./panelFit"
import type { FocusSessionRequest } from "./sessionViewSearch"

/**
 * A tab for the panel to open, asked for outside it: a session a top bar button
 * started, or a notebook (Open notebook in the Analysis preview). The panel opens it
 * only while showing `projectId`.
 */
export type ScienceSessionRequest =
  | { projectId: string; pane: Omit<SessionPane, "id"> }
  | { projectId: string; notebookRelPath: string }
  | { projectId: string; fileRelPath: string }

/**
 * Turn an agent to focus into a session request for the panel, once per session:
 * `setRequest` gets it when `focus` names a new session of `projectId`.
 */
export function useFocusSessionRequest(
  projectId: string | undefined,
  focus: FocusSessionRequest | null,
  setRequest: (request: ScienceSessionRequest) => void,
): void {
  const sessionId = focus?.sessionId
  const agentId = focus?.agentId
  const agentLabel = focus?.agentLabel
  useEffect(() => {
    if (!projectId || !sessionId || !agentId || !agentLabel) return
    setRequest({
      projectId,
      pane: {
        kind: "agent",
        sessionId,
        label: agentLabel,
        launch: { type: "agent", agentId, workspaceMode: "policy" },
      },
    })
  }, [agentId, agentLabel, projectId, sessionId, setRequest])
}

/**
 * Whether a view's right panel is collapsed, whether its documents part (the
 * project view's right sidebar: Research, TODOs, Files, Diary, pinned panels) is on,
 * and the documents tab shown. The collapsed state and the tab are the view's own.
 */
export interface SciencePanelState {
  collapsed: boolean
  setCollapsed: (next: boolean) => void
  /** Whether the documents part is on; it shows only while the panel is open. */
  documentsOpen: boolean
  /** The documents tab shown (a right sidebar tab id). */
  documentsTab: string
  setDocumentsTab: (id: string) => void
  /** Open the panel with the documents on the Diary tab. */
  showDiary: () => void
  /** The top bar diary button: {@link showDiary}, or while the Diary tab shows, hide it. */
  toggleDiary: () => void
}

/**
 * The right panel state of Analysis or Tasks (see {@link SciencePanelState}). The
 * documents part is on or off by one saved value for both views
 * (`useResearchDiaryOpen`); the panel starts open while it is on (the default), else
 * collapsed, and the documents start on the Diary tab. The top bar diary button,
 * pressed while the Diary tab shows, turns the documents part off.
 */
export function useSciencePanel(): SciencePanelState {
  const [documentsOpen, setDocumentsOpen] = useResearchDiaryOpen()
  const [collapsed, setCollapsed] = useState(!documentsOpen)
  const [documentsTab, setDocumentsTab] = useState(DIARY_TAB_ID)
  const showDiary = useCallback(() => {
    setCollapsed(false)
    setDocumentsOpen(true)
    setDocumentsTab(DIARY_TAB_ID)
  }, [setDocumentsOpen])
  const toggleDiary = useCallback(() => {
    if (!collapsed && documentsOpen && documentsTab === DIARY_TAB_ID) setDocumentsOpen(false)
    else showDiary()
  }, [collapsed, documentsOpen, documentsTab, setDocumentsOpen, showDiary])
  return {
    collapsed,
    setCollapsed,
    documentsOpen,
    documentsTab,
    setDocumentsTab,
    showDiary,
    toggleDiary,
  }
}

/** A row's measured width in px (`Infinity` until measured or while not laid out), via a ref callback. */
export function useMeasuredWidth(): [(node: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!node) return
    const measure = () => {
      const next = node.getBoundingClientRect().width
      setWidth(next > 0 ? next : Number.POSITIVE_INFINITY)
    }
    measure()
    observer.current = new ResizeObserver(measure)
    observer.current.observe(node)
  }, [])
  useEffect(() => () => observer.current?.disconnect(), [])
  return [ref, width]
}

/** The right panel's saved width, being dragged live, and its setters. */
export interface SciencePanelWidth {
  /** The saved width (live while dragging); the drawn width can be smaller. */
  saved: number
  /** The width the panel is drawn at now. */
  drawn: number
  setWidth: (next: number) => void
  persistWidth: (next: number) => void
}

/** A view's row of cards with the right panel, fitted to the row's width (see {@link fitPanelRow}). */
export interface SciencePanelRow {
  /** Ref for the row element that is measured. */
  rowRef: (node: HTMLElement | null) => void
  fit: PanelRowFit
  /** The panel state to draw with: collapsed also while there is no room for it. */
  panel: SciencePanelState
  width: SciencePanelWidth
}

/**
 * Fit a view's row (an optional side column, the main card and the right panel,
 * whose saved width and drawn minimum are given) in its width with no horizontal scrolling; see {@link fitPanelRow}. While
 * there is no room the panel is drawn collapsed, but `panel.collapsed` (the
 * user's choice) is kept. Opening it then (its expand button, the top bar diary
 * button, a session that opens) squeezes the others to their minimums, until the
 * row has room again or the user collapses it.
 */
export function useSciencePanelRow(
  panel: SciencePanelState,
  savedPanelWidth: [number, (next: number) => void],
  panelMin: number,
  side: PanelRowInput["side"],
  main: PanelRowInput["main"],
): SciencePanelRow {
  const [rowRef, available] = useMeasuredWidth()
  const [savedWidth, persistWidth] = savedPanelWidth
  const [width, setWidth] = useState(savedWidth)
  useEffect(() => setWidth(savedWidth), [savedWidth])
  const [squeezeOpen, setSqueezeOpen] = useState(false)
  const input: PanelRowInput = {
    available,
    side,
    main,
    panel: { wanted: width, min: panelMin },
    userCollapsed: panel.collapsed,
    squeezeOpen: false,
  }
  const natural = fitPanelRow(input)
  const fit = squeezeOpen ? fitPanelRow({ ...input, squeezeOpen: true }) : natural
  // Room again (or collapsed by the user): the next shortage collapses the panel again.
  useEffect(() => {
    if (squeezeOpen && natural.open) setSqueezeOpen(false)
  }, [natural.open, squeezeOpen])
  const {
    setCollapsed: setUserCollapsed,
    toggleDiary: userToggleDiary,
    showDiary: userShowDiary,
  } = panel
  const setCollapsed = useCallback(
    (next: boolean) => {
      setSqueezeOpen(!next)
      setUserCollapsed(next)
    },
    [setUserCollapsed],
  )
  const showDiary = useCallback(() => {
    setSqueezeOpen(true)
    userShowDiary()
  }, [userShowDiary])
  const forced = fit.forcedCollapsed
  const toggleDiary = useCallback(() => {
    if (forced) showDiary()
    else userToggleDiary()
  }, [forced, showDiary, userToggleDiary])
  return {
    rowRef,
    fit,
    panel: { ...panel, collapsed: !fit.open, setCollapsed, showDiary, toggleDiary },
    width: { saved: width, drawn: fit.panel, setWidth, persistWidth },
  }
}

/**
 * The button that shows a collapsed right panel again. A collapsed panel draws
 * nothing, so like the project view's right sidebar the button sits at the right
 * end of the toolbar of the card next to it.
 */
export function PanelExpandButton({
  testId,
  label,
  help,
  onClick,
}: {
  testId: string
  label: string
  help: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={label}
      aria-label={label}
      data-feature-help={help}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <PanelRightOpen className="size-4" aria-hidden />
    </button>
  )
}

/** The expand button of the Analysis and Tasks right panel, or null while it is open. */
export function SciencePanelExpandButton({ panel }: { panel: SciencePanelState }) {
  const t = useTranslate()
  if (!panel.collapsed) return null
  return (
    <PanelExpandButton
      testId="science-sessions-expand"
      label={t("Show sessions")}
      help={t("Open the panel with this project's agent and terminal sessions and its documents.")}
      onClick={() => panel.setCollapsed(false)}
    />
  )
}

/**
 * The top bar Research diary button of a view with a right panel: icon-only,
 * pressed while the documents show the Diary tab. It opens the panel on the Diary
 * tab, or while that shows, hides it. `disabled` (no project chosen) asks to pick one.
 */
export function SciencePanelDiaryButton({
  testId,
  panel,
  disabled,
}: {
  testId: string
  panel: SciencePanelState
  disabled: boolean
}) {
  const t = useTranslate()
  const shown =
    !disabled && !panel.collapsed && panel.documentsOpen && panel.documentsTab === DIARY_TAB_ID
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={t("Research diary")}
      aria-pressed={shown}
      title={disabled ? t("Pick a project") : t("Research diary")}
      data-feature-label={t("Research diary")}
      data-feature-help={t("Open the right panel on the chosen project's research diary")}
      disabled={disabled}
      onClick={panel.toggleDiary}
      className={cn(headerIconButtonClass, shown && "text-foreground")}
    >
      <NotebookPen className="size-3.5 shrink-0" aria-hidden />
    </button>
  )
}

interface ScienceSessionPanelProps {
  view: SessionPanelView
  /** The project sessions start in, or null when none is chosen (Tasks "All projects"). */
  project: { id: string; name: string } | null
  /** Collapsed state and diary choice, fitted to the row ({@link useSciencePanelRow}). */
  panel: SciencePanelState
  /** The panel's saved and drawn width ({@link useSciencePanelRow}). */
  width: SciencePanelWidth
  /** A started session to open as a tab, or null. */
  openSession: ScienceSessionRequest | null
  /** Called once `openSession` is open, so the caller can clear it. */
  onSessionOpened: () => void
}

/**
 * The right panel of Tasks and Analysis: agent and terminal sessions on top, and
 * the chosen project's documents below (when they are on): the project view's right
 * sidebar, with its tabs and pinned panels, but no collapse button of its own. A
 * draggable divider between them has its position saved as the documents' height
 * share. Like the project view, the Sessions part and the documents part are each
 * their own rounded card, 12px apart; the Sessions card's toolbar row holds its
 * title and the collapse button of the whole panel. A file the Files tab opens
 * opens as a tab in the Sessions card. The
 * panel resizes from the gap on its left, and the gap between the cards is the
 * divider. The width is one saved value for Analysis and Tasks. The sessions part is built from the same central panel as the LaTeX
 * Editor (with its "+", agent and terminal buttons), and its sessions start in the
 * selected project's main folder. The panel starts open with the diary while
 * the diary is on (the default), else collapsed; collapsing hides both parts. It opens when a session opens. ⌘T (Settings → Shortcuts) opens a
 * session here, collapsed or not. Its tabs are kept per project and view, like the
 * LaTeX Editor's. With no project chosen, ⌘T and the buttons ask to pick one and
 * there is no diary. `openSession` (from a top bar button) opens as a tab and
 * shows the panel.
 */
export function ScienceSessionPanel({
  view,
  project,
  panel,
  width,
  openSession,
  onSessionOpened,
}: ScienceSessionPanelProps) {
  const t = useTranslate()
  const { collapsed, setCollapsed } = panel
  const expand = useCallback(() => setCollapsed(false), [setCollapsed])
  const [savedShare, persistShare] = useResearchDiaryShare()
  const [share, setShare] = useState(savedShare)
  useEffect(() => setShare(savedShare), [savedShare])
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // Removes a drag's window listeners; also run if the panel unmounts mid-drag.
  const endDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => endDrag.current?.(), [])
  const diaryProjectId = !collapsed && panel.documentsOpen && project ? project.id : null
  // A file the documents' Files tab opens, until the Sessions card has opened it.
  const [fileRequest, setFileRequest] = useState<ScienceSessionRequest | null>(null)
  const request = openSession ?? fileRequest
  const requestOpened = useCallback(() => {
    if (openSession) onSessionOpened()
    else setFileRequest(null)
  }, [onSessionOpened, openSession])

  // Dragging the divider sets the diary's share of the panel body's height.
  const onDividerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current
    if (event.button !== 0 || !body) return
    event.preventDefault()
    const target = event.currentTarget
    const pointerId = event.pointerId
    target.setPointerCapture(pointerId)
    let next = share
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return
      const box = body.getBoundingClientRect()
      if (box.height <= 0) return
      const raw = (box.bottom - move.clientY) / box.height
      next = Math.min(Math.max(raw, RESEARCH_DIARY_MIN_SHARE), RESEARCH_DIARY_MAX_SHARE)
      setShare(next)
    }
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      endDrag.current = null
    }
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return
      cleanup()
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      persistShare(next)
    }
    endDrag.current?.()
    endDrag.current = cleanup
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
  }

  const header: SessionsHeader = {
    title: (
      <span
        data-testid="science-sessions-header"
        className="truncate text-muted-foreground text-xs"
      >
        {t("Sessions")}
      </span>
    ),
    collapse: (
      <button
        type="button"
        data-testid="science-sessions-collapse"
        title={t("Hide sessions")}
        aria-label={t("Hide sessions")}
        data-feature-help={t("Collapse this panel to give the main view more room.")}
        onClick={() => setCollapsed(true)}
        className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <PanelRightClose className="size-4" aria-hidden />
      </button>
    ),
  }

  // Open: the Sessions card and the diary card, 12px apart, each with its own header;
  // the panel resizes from the gap on its left (dragging it below the minimum width
  // collapses the panel), and the gap between the cards is the divider. Collapsed:
  // nothing is drawn (the expand button is in the next card's toolbar, see
  // SciencePanelExpandButton). One tree for both, so the sessions part is not
  // remounted (with notebook tabs it stays mounted, hidden, while collapsed).
  return (
    <aside
      data-testid="science-sessions"
      data-collapsed={collapsed}
      hidden={collapsed}
      className={collapsed ? "hidden" : "relative flex min-h-0 shrink-0 flex-col"}
      style={collapsed ? undefined : { width: width.drawn }}
    >
      {collapsed ? null : (
        <EdgeResizeHandle
          side="left"
          width={width.drawn}
          onResize={width.setWidth}
          onResizeEnd={width.persistWidth}
          onCollapse={() => setCollapsed(true)}
          min={SCIENCE_PANEL_MIN_WIDTH}
          max={SCIENCE_PANEL_MAX_WIDTH}
          testId="science-sessions-edge-drag"
        />
      )}
      <div
        ref={bodyRef}
        className={collapsed ? "contents" : "flex min-h-0 min-w-0 flex-1 flex-col"}
      >
        <div
          data-testid="science-panel-sessions"
          className={collapsed ? "contents" : "flex min-h-0 min-w-0 flex-col"}
          style={collapsed ? undefined : { flex: diaryProjectId ? `${1 - share} 1 0` : "1 1 0" }}
        >
          {project ? (
            <ProjectSessions
              key={project.id}
              view={view}
              project={project}
              collapsed={collapsed}
              header={header}
              onExpand={expand}
              openSession={request?.projectId === project.id ? request : null}
              onSessionOpened={requestOpened}
            />
          ) : (
            <NoProjectSessions collapsed={collapsed} header={header} onExpand={expand} />
          )}
        </div>
        {diaryProjectId ? (
          <>
            <div
              data-testid="science-panel-divider"
              aria-hidden
              onPointerDown={onDividerDown}
              className="app-no-drag group flex h-3 shrink-0 cursor-row-resize items-center"
            >
              <div className="h-1.5 w-full rounded-full transition-colors group-hover:bg-primary/30" />
            </div>
            <div
              data-testid="science-panel-diary"
              className="flex min-h-0 min-w-0 flex-col"
              style={{ flex: `${share} 1 0` }}
            >
              <ProjectDocumentsCard
                key={diaryProjectId}
                projectId={diaryProjectId}
                activeId={panel.documentsTab}
                onActiveIdChange={panel.setDocumentsTab}
                onCollapse={null}
                onOpenFile={(relPath) =>
                  setFileRequest({ projectId: diaryProjectId, fileRelPath: relPath })
                }
              />
            </div>
          </>
        ) : null}
      </div>
    </aside>
  )
}

/** The Sessions card's title and collapse button, shown in its toolbar row. */
interface SessionsHeader {
  title: ReactNode
  collapse: ReactNode
}

/**
 * The Sessions card while it has no central panel to show (the workspace is loading,
 * or failed to open): the same toolbar row with the title and collapse button, over `children`.
 */
function SessionsCard({ header, children }: { header: SessionsHeader; children: ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border">
      <div className="flex shrink-0 items-center gap-0.5 border-border border-b bg-muted/30 pr-1 pl-3">
        <div className="flex min-w-0 flex-1 items-center">{header.title}</div>
        {header.collapse}
      </div>
      {children}
    </div>
  )
}

interface SessionsBodyProps {
  collapsed: boolean
  header: SessionsHeader
  onExpand: () => void
}

interface OpenSessionProps {
  openSession: ScienceSessionRequest | null
  onSessionOpened: () => void
}

/** Resolve the project's main-checkout workspace, then show its sessions. */
function ProjectSessions({
  view,
  project,
  collapsed,
  header,
  onExpand,
  openSession,
  onSessionOpened,
}: SessionsBodyProps &
  OpenSessionProps & { view: SessionPanelView; project: { id: string; name: string } }) {
  const trpc = useTRPC()
  const ensureMain = useMutation(trpc.workspaces.ensureMain.mutationOptions())
  const ensureMainRef = useRef(ensureMain.mutateAsync)
  ensureMainRef.current = ensureMain.mutateAsync
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  // Same pattern as the Project view: every effect run fires (ensureMain is idempotent)
  // and only the still-active run applies its result; errors show from `ensureMain.error`.
  useEffect(() => {
    let active = true
    ensureMainRef.current({ projectId: project.id }).then(
      (workspace) => {
        if (active) setWorkspaceId(workspace.id)
      },
      () => undefined,
    )
    return () => {
      active = false
    }
  }, [project.id])
  if (ensureMain.error && !collapsed) {
    return (
      <SessionsCard header={header}>
        <p role="alert" className="cursor-text select-text p-3 text-destructive text-xs">
          {ensureMain.error.message}
        </p>
      </SessionsCard>
    )
  }
  if (!workspaceId) return collapsed ? null : <SessionsCard header={header}>{null}</SessionsCard>
  return (
    <SessionsBody
      view={view}
      project={project}
      workspaceId={workspaceId}
      collapsed={collapsed}
      header={header}
      onExpand={onExpand}
      openSession={openSession}
      onSessionOpened={onSessionOpened}
    />
  )
}

/** The central panel for one project's workspace, with its tabs kept per view. */
function SessionsBody({
  view,
  project,
  workspaceId,
  collapsed,
  header,
  onExpand,
  openSession,
  onSessionOpened,
}: SessionsBodyProps &
  OpenSessionProps & {
    view: SessionPanelView
    project: { id: string; name: string }
    workspaceId: string
  }) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const settings: EditorSettings = settingsQuery.data?.editor ?? DEFAULT_EDITOR_SETTINGS
  const updateEditor = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
      },
    }),
  )
  const [filesPanelOpen, setFilesPanelOpen] = useState(false)

  // Tabs are kept with the same recovery store as the LaTeX Editor, under their own key,
  // and only for this workspace.
  const stateKey = sessionPanelWorkspaceKey(view, project.id)
  const restoredState = useRef(restorableState(stateKey, workspaceId)).current
  const onStateChange = useCallback(
    (state: CentralPanelRestoreState) => writeProjectWorkspaceState(stateKey, state, workspaceId),
    [stateKey, workspaceId],
  )
  const onBuffersChange = useCallback(
    (buffers: OpenBuffer[]) => workspaceRecovery().updateBuffers(stateKey, () => buffers),
    [stateKey],
  )
  useEffect(() => () => workspaceRecovery().flush(stateKey), [stateKey])
  const retainedBuffers = useMemo<RetainedBuffers>(
    () => ({
      read: () => workspaceRecovery().read(stateKey, true)?.buffers ?? [],
      update: (update) => workspaceRecovery().updateBuffers(stateKey, update),
    }),
    [stateKey],
  )
  const controller = useCentralPanel({
    client,
    workspaceId,
    projectId: project.id,
    origin: originFor(view),
    settings,
    initialState: restoredState,
    onStateChange,
    onBuffersChange,
    retainedBuffers,
  })
  // Lets the quit dialog save this panel's unsaved files through the mounted editor.
  const editorRef = useRef(controller)
  editorRef.current = controller
  useEffect(() => registerProjectEditor(stateKey, () => editorRef.current), [stateKey])

  // Show the panel when it has restored tabs, a session opens, the agent chooser opens
  // or a launch fails, so nothing happens out of sight.
  const sessionCount = controller.sessions.length
  const seenSessions = useRef(0)
  useEffect(() => {
    if (sessionCount > seenSessions.current) onExpand()
    seenSessions.current = sessionCount
  }, [onExpand, sessionCount])
  const restoredFiles = (restoredState?.buffers.length ?? 0) > 0
  useEffect(() => {
    if (restoredFiles) onExpand()
  }, [onExpand, restoredFiles])
  useEffect(() => {
    if (controller.agentChooserOpen || controller.launchError) onExpand()
  }, [controller.agentChooserOpen, controller.launchError, onExpand])

  // A session a top bar button started, or a notebook to open, opens here as a tab
  // and shows the panel.
  const attachSession = controller.attachSession
  const openNotebook = controller.openNotebook
  const openFile = controller.openFile
  useEffect(() => {
    if (!openSession) return
    if ("pane" in openSession) attachSession(openSession.pane)
    else if ("notebookRelPath" in openSession) openNotebook(openSession.notebookRelPath)
    else openFile(openSession.fileRelPath)
    onExpand()
    onSessionOpened()
  }, [attachSession, onExpand, onSessionOpened, openFile, openNotebook, openSession])

  // While collapsed the central panel is not mounted (or hidden, with its shortcuts
  // off), so ⌘T is handled here.
  const openNewSession = useOpenNewSession(controller)
  useNewSessionShortcut(() => {
    if (!collapsed || overlayIsOpen()) return false
    return openNewSession()
  })

  // Collapsed, the central panel is not shown. With notebook tabs it stays mounted
  // (hidden), so the notebook pages keep their unsaved edits and their servers run.
  if (collapsed && controller.notebooks.length === 0) return null
  return (
    <div
      hidden={collapsed}
      className={collapsed ? "hidden" : "relative flex min-h-0 min-w-0 flex-1 flex-col"}
    >
      <CentralPanel
        controller={controller}
        client={client}
        workspaceId={workspaceId}
        openFileFinder={false}
        onFileFinderOpened={() => undefined}
        projectName={project.name}
        settings={settings}
        onUpdateEditorSettings={(patch) => updateEditor.mutate(patch)}
        rightSidebarCollapsed={false}
        onExpandRightSidebar={() => undefined}
        filesPanelOpen={filesPanelOpen}
        onFilesPanelOpenChange={setFilesPanelOpen}
        hidden={collapsed}
        toolbarTitle={header.title}
        toolbarEnd={
          <>
            <ToolbarSeparator />
            {header.collapse}
          </>
        }
      />
    </div>
  )
}

/** Agents started here record the view they came from. */
function originFor(view: SessionPanelView): AgentSessionOrigin {
  return view
}

/** The saved panel state, only when it belongs to this workspace. */
function restorableState(
  stateKey: string,
  workspaceId: string,
): CentralPanelRestoreState | undefined {
  const state = readProjectWorkspaceState(stateKey, readRestoreProjectTabs())
  return state?.workspaceId === workspaceId ? state : undefined
}

/** No project chosen: ⌘T and the session buttons show a notice to pick one. */
function NoProjectSessions({ collapsed, header, onExpand }: SessionsBodyProps) {
  const t = useTranslate()
  const [notice, setNotice] = useState(false)
  const ask = (): void => {
    onExpand()
    setNotice(true)
  }
  useNewSessionShortcut(() => {
    if (overlayIsOpen()) return false
    ask()
    return true
  })
  if (collapsed) return null
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border">
      <div className="flex shrink-0 items-center gap-0.5 border-border border-b bg-muted/30 pr-1 pl-3">
        <div className="flex min-w-0 flex-1 items-center">{header.title}</div>
        <NoticeButton testId="science-sessions-add" label={t("Add pane")} onClick={ask}>
          <Plus className="size-4" aria-hidden />
        </NoticeButton>
        <NoticeButton testId="science-sessions-new-agent" label={t("New agent")} onClick={ask}>
          <Bot className="size-4" aria-hidden />
        </NoticeButton>
        <NoticeButton
          testId="science-sessions-new-terminal"
          label={t("New terminal")}
          onClick={ask}
        >
          <TerminalSquare className="size-4" aria-hidden />
        </NoticeButton>
        <ToolbarSeparator />
        {header.collapse}
      </div>
      {notice ? (
        <div
          role="status"
          className="m-3 flex items-center justify-between gap-2 rounded border border-border px-3 py-2 text-xs"
        >
          <span data-testid="science-sessions-notice">{t("Pick a project to open a session")}</span>
          <button
            type="button"
            data-testid="science-sessions-dismiss-notice"
            aria-label={t("Dismiss")}
            onClick={() => setNotice(false)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : (
        <p className="p-3 text-muted-foreground text-xs">
          {t("Sessions start in the selected project's folder.")}
        </p>
      )}
    </div>
  )
}

/** A session button that, with no project chosen, only shows the pick-a-project notice. */
function NoticeButton({
  testId,
  label,
  onClick,
  children,
}: {
  testId: string
  label: string
  onClick: () => void
  children: ReactNode
}) {
  const t = useTranslate()
  return (
    <button
      type="button"
      data-testid={testId}
      title={label}
      aria-label={label}
      data-feature-help={t("Pick a project first to open a session.")}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  )
}

/** A short upright line between toolbar button groups, like the central panel's own. */
function ToolbarSeparator() {
  return <div aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
}
