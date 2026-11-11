import type { AgentSessionOrigin } from "@pi-lab/local-db"
import { DEFAULT_EDITOR_SETTINGS, type EditorSettings } from "@pi-lab/local-db/editor-settings"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, PanelRightClose, PanelRightOpen, Plus, TerminalSquare, X } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { OpenBuffer } from "../../../../../Editor/hooks/useEditorBuffers"
import type { RetainedBuffers } from "../../../../../Editor/hooks/useEditorBuffers/useEditorBuffers"
import { useTranslate } from "../../../../../i18n/language"
import { readRestoreProjectTabs } from "../../../../../preferences/preferences"
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
import type { FocusSessionRequest } from "./sessionViewSearch"

/**
 * A tab for the panel to open, asked for outside it: a session a top bar button
 * started, or a notebook (Open notebook in the Analysis preview). The panel opens it
 * only while showing `projectId`.
 */
export type ScienceSessionRequest =
  | { projectId: string; pane: Omit<SessionPane, "id"> }
  | { projectId: string; notebookRelPath: string }

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

interface ScienceSessionPanelProps {
  view: SessionPanelView
  /** The project sessions start in, or null when none is chosen (Tasks "All projects"). */
  project: { id: string; name: string } | null
  /** A started session to open as a tab, or null. */
  openSession: ScienceSessionRequest | null
  /** Called once `openSession` is open, so the caller can clear it. */
  onSessionOpened: () => void
}

/**
 * Agent and terminal sessions beside the Tasks or Analysis content: a panel on the
 * right, built from the same central panel as the LaTeX Editor (with its "+", agent
 * and terminal buttons), whose sessions start in the selected project's main folder.
 * It starts collapsed and opens when a session opens. ⌘T (Settings → Shortcuts) opens
 * a session here, collapsed or not. Its tabs are kept per project and view, like the
 * LaTeX Editor's. With no project chosen, ⌘T and the buttons ask to pick one.
 * `openSession` (from a top bar button) opens as a tab and shows the panel.
 */
export function ScienceSessionPanel({
  view,
  project,
  openSession,
  onSessionOpened,
}: ScienceSessionPanelProps) {
  const t = useTranslate()
  const [collapsed, setCollapsed] = useState(true)
  const expand = useCallback(() => setCollapsed(false), [])
  return (
    <aside
      data-testid="science-sessions"
      data-collapsed={collapsed}
      className={
        collapsed
          ? "flex w-9 shrink-0 flex-col items-center border-border border-l py-2"
          : "flex w-[520px] min-w-[22rem] shrink flex-col border-border border-l"
      }
    >
      {collapsed ? (
        <button
          type="button"
          data-testid="science-sessions-expand"
          title={t("Show sessions")}
          aria-label={t("Show sessions")}
          data-feature-help={t("Open the panel with this project's agent and terminal sessions.")}
          onClick={expand}
          className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PanelRightOpen className="size-4" aria-hidden />
        </button>
      ) : (
        <div className="flex h-8 shrink-0 items-center justify-between border-border border-b px-2">
          <span className="text-muted-foreground text-xs">{t("Sessions")}</span>
          <button
            type="button"
            data-testid="science-sessions-collapse"
            title={t("Hide sessions")}
            aria-label={t("Hide sessions")}
            data-feature-help={t("Collapse this panel to give the main view more room.")}
            onClick={() => setCollapsed(true)}
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <PanelRightClose className="size-4" aria-hidden />
          </button>
        </div>
      )}
      {project ? (
        <ProjectSessions
          key={project.id}
          view={view}
          project={project}
          collapsed={collapsed}
          onExpand={expand}
          openSession={openSession?.projectId === project.id ? openSession : null}
          onSessionOpened={onSessionOpened}
        />
      ) : (
        <NoProjectSessions collapsed={collapsed} onExpand={expand} />
      )}
    </aside>
  )
}

interface SessionsBodyProps {
  collapsed: boolean
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
      collapsed={collapsed}
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
  useEffect(() => {
    if (!openSession) return
    if ("pane" in openSession) attachSession(openSession.pane)
    else openNotebook(openSession.notebookRelPath)
    onExpand()
    onSessionOpened()
  }, [attachSession, onExpand, onSessionOpened, openNotebook, openSession])

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
function NoProjectSessions({ collapsed, onExpand }: SessionsBodyProps) {
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-end gap-0.5 border-border border-b px-1">
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
