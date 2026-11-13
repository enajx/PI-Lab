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
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { EdgeResizeHandle } from "../../../../../components/EdgeResizeHandle"
import { headerIconButtonClass } from "../../../../../components/HeaderShortcuts/HeaderShortcuts"
import type { OpenBuffer } from "../../../../../Editor/hooks/useEditorBuffers"
import type { RetainedBuffers } from "../../../../../Editor/hooks/useEditorBuffers/useEditorBuffers"
import { useTranslate } from "../../../../../i18n/language"
import {
  readRestoreProjectTabs,
  SCIENCE_PANEL_MAX_WIDTH,
  SCIENCE_PANEL_MIN_WIDTH,
  useResearchDiaryOpen,
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

/** Id of the Sessions tab, first in the Analysis and Tasks right panel. */
export const SESSIONS_TAB_ID = "sessions"

/**
 * Whether a view's right panel is collapsed, and the tab it shows (a right sidebar
 * tab id; in Analysis and Tasks also {@link SESSIONS_TAB_ID}). Both are the view's own.
 */
export interface SciencePanelState {
  collapsed: boolean
  setCollapsed: (next: boolean) => void
  /** The tab shown (a right sidebar tab id). */
  documentsTab: string
  setDocumentsTab: (id: string) => void
  /** Open the panel on the Diary tab. */
  showDiary: () => void
  /** The top bar diary button: {@link showDiary}, or while the Diary tab shows, hide the panel. */
  toggleDiary: () => void
}

/** The sessionStorage key of a view's last right panel tab. */
function panelTabKey(view: SessionPanelView): string {
  return `pi-lab.sciencePanel.tab.${view}`
}

/**
 * The right panel state of Analysis or Tasks (see {@link SciencePanelState}). It
 * starts open while `useResearchDiaryOpen` is on (the default), else collapsed; the
 * top bar diary button turns that value off when it hides the panel and on when it
 * opens it. The panel opens on `defaultTab` the first time (Sessions in Analysis, the
 * Diary in Tasks), then on the view's last tab, kept for the app session (sessionStorage).
 */
export function useSciencePanel(view: SessionPanelView, defaultTab: string): SciencePanelState {
  const [startOpen, setStartOpen] = useResearchDiaryOpen()
  const [collapsed, setCollapsed] = useState(!startOpen)
  const [documentsTab, setTab] = useState(
    () => window.sessionStorage.getItem(panelTabKey(view)) ?? defaultTab,
  )
  const setDocumentsTab = useCallback(
    (id: string) => {
      window.sessionStorage.setItem(panelTabKey(view), id)
      setTab(id)
    },
    [view],
  )
  const showDiary = useCallback(() => {
    setCollapsed(false)
    setStartOpen(true)
    setDocumentsTab(DIARY_TAB_ID)
  }, [setDocumentsTab, setStartOpen])
  const toggleDiary = useCallback(() => {
    if (!collapsed && documentsTab === DIARY_TAB_ID) {
      setCollapsed(true)
      setStartOpen(false)
    } else showDiary()
  }, [collapsed, documentsTab, setStartOpen, showDiary])
  return { collapsed, setCollapsed, documentsTab, setDocumentsTab, showDiary, toggleDiary }
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

/**
 * The Analysis and Tasks right panel while collapsed: a thin bar card of its own
 * holding the expand button, or null while the panel is open.
 */
export function SciencePanelCollapsedBar({
  testId,
  panel,
}: {
  testId: string
  panel: SciencePanelState
}) {
  const t = useTranslate()
  if (!panel.collapsed) return null
  return (
    <div
      data-testid={testId}
      className="flex w-9 shrink-0 flex-col items-center rounded-lg border border-border py-1"
    >
      <PanelExpandButton
        testId="science-sessions-expand"
        label={t("Show sessions")}
        help={t(
          "Open the panel with this project's agent and terminal sessions and its documents.",
        )}
        onClick={() => panel.setCollapsed(false)}
      />
    </div>
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
  const shown = !disabled && !panel.collapsed && panel.documentsTab === DIARY_TAB_ID
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
  /** Collapsed state and tab, fitted to the row ({@link useSciencePanelRow}). */
  panel: SciencePanelState
  /** The panel's saved and drawn width ({@link useSciencePanelRow}). */
  width: SciencePanelWidth
  /** A started session to open as a tab, or null. */
  openSession: ScienceSessionRequest | null
  /** Called once `openSession` is open, so the caller can clear it. */
  onSessionOpened: () => void
}

/**
 * The right panel of Tasks and Analysis: one rounded card, the project view's right
 * sidebar with a Sessions tab first, then its own tabs (Files, Research, TODOs, Diary
 * and the pinned panels). The Sessions tab holds the agent and terminal sessions
 * (the same central panel as the LaTeX Editor, with its "+", agent and terminal
 * buttons), which start in the selected project's main folder. They stay mounted,
 * hidden, while another tab shows or the panel is collapsed, so notebooks and
 * terminals do not reload. The sidebar's collapse button collapses the panel (the
 * view then draws {@link SciencePanelCollapsedBar}). The panel resizes from the gap
 * on its left; the width is one saved value for Analysis and Tasks. A session that
 * opens (a top bar button, ⌘T, a notebook, a file from the Files tab) shows the
 * Sessions tab and opens the panel. ⌘T (Settings → Shortcuts) opens a session here,
 * collapsed or not. Its tabs are kept per project and view, like the LaTeX Editor's.
 * With no project chosen there is only a Sessions card, where ⌘T and the buttons
 * ask to pick one.
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
  const { collapsed, setCollapsed, setDocumentsTab } = panel
  const showSessions = useCallback(() => {
    setCollapsed(false)
    setDocumentsTab(SESSIONS_TAB_ID)
  }, [setCollapsed, setDocumentsTab])
  const expand = useCallback(() => setCollapsed(false), [setCollapsed])
  const sessionsShown = !collapsed && panel.documentsTab === SESSIONS_TAB_ID
  // A file the Files tab opens, until the Sessions tab has opened it.
  const [fileRequest, setFileRequest] = useState<ScienceSessionRequest | null>(null)
  const request = openSession ?? fileRequest
  const requestOpened = useCallback(() => {
    if (openSession) onSessionOpened()
    else setFileRequest(null)
  }, [onSessionOpened, openSession])

  // Collapsed, nothing is drawn but the tree stays mounted (hidden), so the sessions
  // keep running.
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
      {project ? (
        <ProjectDocumentsCard
          key={project.id}
          projectId={project.id}
          // Collapsed, only the Sessions content stays mounted: the other tabs unmount,
          // so the diary saves its unsaved edits on leaving, as it does on a tab switch.
          activeId={collapsed ? SESSIONS_TAB_ID : panel.documentsTab}
          onActiveIdChange={setDocumentsTab}
          onCollapse={() => setCollapsed(true)}
          onOpenFile={(relPath) => setFileRequest({ projectId: project.id, fileRelPath: relPath })}
          leadingTab={{
            id: SESSIONS_TAB_ID,
            label: t("Sessions"),
            description: t("This project's agent and terminal sessions."),
            content: (
              <ProjectSessions
                view={view}
                project={project}
                hidden={!sessionsShown}
                onExpand={expand}
                onShowSessions={showSessions}
                openSession={request?.projectId === project.id ? request : null}
                onSessionOpened={requestOpened}
              />
            ),
          }}
        />
      ) : (
        <NoProjectSessions
          collapsed={collapsed}
          onCollapse={() => setCollapsed(true)}
          onExpand={expand}
        />
      )}
    </aside>
  )
}

interface SessionsBodyProps {
  /** Whether the sessions are not shown (another tab, or the panel collapsed). */
  hidden: boolean
  /** Open the panel on its current tab. */
  onExpand: () => void
  /** Open the panel on the Sessions tab. */
  onShowSessions: () => void
}

interface OpenSessionProps {
  openSession: ScienceSessionRequest | null
  onSessionOpened: () => void
}

/** Resolve the project's main-checkout workspace, then show its sessions. */
function ProjectSessions({
  view,
  project,
  hidden,
  onExpand,
  onShowSessions,
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
  if (ensureMain.error) {
    return (
      <p role="alert" className="cursor-text select-text p-3 text-destructive text-xs">
        {ensureMain.error.message}
      </p>
    )
  }
  if (!workspaceId) return null
  return (
    <SessionsBody
      view={view}
      project={project}
      workspaceId={workspaceId}
      hidden={hidden}
      onExpand={onExpand}
      onShowSessions={onShowSessions}
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
  hidden,
  onExpand,
  onShowSessions,
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

  // Open the panel when it has restored tabs (on its current tab), and show the
  // Sessions tab when a session opens, the agent chooser opens or a launch fails, so
  // nothing happens out of sight.
  const sessionCount = controller.sessions.length
  const seenSessions = useRef(sessionCount)
  useEffect(() => {
    if (sessionCount > seenSessions.current) onShowSessions()
    seenSessions.current = sessionCount
  }, [onShowSessions, sessionCount])
  const restoredTabs = (restoredState?.buffers.length ?? 0) > 0 || seenSessions.current > 0
  useEffect(() => {
    if (restoredTabs) onExpand()
  }, [onExpand, restoredTabs])
  useEffect(() => {
    if (controller.agentChooserOpen || controller.launchError) onShowSessions()
  }, [controller.agentChooserOpen, controller.launchError, onShowSessions])

  // A session a top bar button started, a notebook or a file to open, opens here as a
  // tab and shows the Sessions tab.
  const attachSession = controller.attachSession
  const openNotebook = controller.openNotebook
  const openFile = controller.openFile
  useEffect(() => {
    if (!openSession) return
    if ("pane" in openSession) attachSession(openSession.pane)
    else if ("notebookRelPath" in openSession) openNotebook(openSession.notebookRelPath)
    else openFile(openSession.fileRelPath)
    onShowSessions()
    onSessionOpened()
  }, [attachSession, onShowSessions, onSessionOpened, openFile, openNotebook, openSession])

  // While hidden the central panel's shortcuts are off, so ⌘T is handled here.
  const openNewSession = useOpenNewSession(controller)
  useNewSessionShortcut(() => {
    if (!hidden || overlayIsOpen()) return false
    return openNewSession()
  })

  // The central panel stays mounted while hidden (another tab, or the panel
  // collapsed), so notebook pages keep their unsaved edits, their servers run and
  // terminals do not reload.
  return (
    <div
      hidden={hidden}
      className={hidden ? "hidden" : "relative flex min-h-0 min-w-0 flex-1 flex-col"}
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
        hidden={hidden}
        frameless
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

/**
 * No project chosen: a Sessions card with the session buttons and the panel's
 * collapse button; ⌘T and the buttons show a notice to pick one.
 */
function NoProjectSessions({
  collapsed,
  onCollapse,
  onExpand,
}: {
  collapsed: boolean
  onCollapse: () => void
  onExpand: () => void
}) {
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
        <div className="flex min-w-0 flex-1 items-center">
          <span
            data-testid="science-sessions-header"
            className="truncate text-muted-foreground text-xs"
          >
            {t("Sessions")}
          </span>
        </div>
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
        <button
          type="button"
          data-testid="science-sessions-collapse"
          title={t("Hide sessions")}
          aria-label={t("Hide sessions")}
          data-feature-help={t("Collapse this panel to give the main view more room.")}
          onClick={onCollapse}
          className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelRightClose className="size-4" aria-hidden />
        </button>
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
