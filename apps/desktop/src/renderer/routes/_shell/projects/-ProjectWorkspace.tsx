import type { EditorSettings } from "@pi-lab/local-db/editor-settings"
import { DEFAULT_EDITOR_SETTINGS } from "@pi-lab/local-db/editor-settings"
import { cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Telescope, X } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { CaffeineControl } from "../../../caffeine"
import { EdgeResizeHandle } from "../../../components/EdgeResizeHandle"
import { ProjectWorkflowControl } from "../../../components/ProjectWorkflow"
import type { OpenBuffer } from "../../../Editor/hooks/useEditorBuffers"
import type { RetainedBuffers } from "../../../Editor/hooks/useEditorBuffers/useEditorBuffers"
import { translateKnownError } from "../../../i18n/errors"
import { useInterfaceLanguage, useTranslate } from "../../../i18n/language"
import type { ProjectNotificationSearch } from "../../../notifications/activation"
import {
  RIGHT_SIDEBAR_MAX_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
  readRestoreProjectTabs,
  useNonGitNoticeDismissed,
  useRightSidebarWidth,
  useSidebarCollapsed,
} from "../../../preferences/preferences"
import { stripOuterQuery } from "../../../QuickEditor/routeTarget"
import { useTRPC, useTRPCClient } from "../../../trpc/react"
import { useOptionalNewFileController } from "../components/NewFileController"
import { AgentStatusControl, titleBarControlClass, titleBarInsetHeaderClass } from "../titleBar"
import { clearPendingLaunch, readPendingLaunch } from "./-pendingLaunch"
import { clearPendingOpenFile, usePendingOpenFile } from "./-pendingOpenFile"
import { clearPendingTaskSession, readPendingTaskSession } from "./-pendingTaskSession"
import { registerProjectEditor, saveProjectBuffer } from "./-workspaceEditorOperations"
import {
  readProjectWorkspaceState,
  workspaceRecovery,
  writeProjectWorkspaceState,
  writeProjectWorkspaceViewState,
} from "./-workspaceState"
import { CentralPanel, useCentralPanel } from "./components/CentralPanel"
import type { CentralPanelRestoreState } from "./components/CentralPanel/useCentralPanel"
import { ProjectPalette } from "./components/ProjectPalette"
import { RightSidebar } from "./components/RightSidebar"

/**
 * Everything binds to the project's **main checkout** — a `kind:"branch"`
 * workspace ensured once on mount via `workspaces.ensureMain` (idempotent). Files
 * read/write through the `files` router against that workspace with no agent
 * required; opening an agent (`sessions.start`) or a terminal
 * (`workspaces.spawnTerminal`) attaches a session pane in the central panel.
 */
export function ProjectWorkspace({
  projectId,
  activation,
}: {
  projectId: string
  activation: ProjectNotificationSearch
}) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const trpc = useTRPC()
  const newFileController = useOptionalNewFileController()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const pendingTaskSession = useRef(readPendingTaskSession(projectId)).current
  const pendingLaunch = useRef(readPendingLaunch(projectId)).current
  const pendingOpenFile = usePendingOpenFile(projectId)
  const restoredWorkspaceState = useRef(
    readProjectWorkspaceState(projectId, readRestoreProjectTabs()),
  ).current

  useEffect(() => {
    if (pendingTaskSession) clearPendingTaskSession(projectId)
  }, [pendingTaskSession, projectId])

  useEffect(() => {
    if (pendingLaunch) clearPendingLaunch(projectId)
  }, [pendingLaunch, projectId])

  const openedProject = useRef<string | null>(null)
  const touchProject = useMutation(
    trpc.projects.touch.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })
      },
    }),
  )
  const markOpened = touchProject.mutate
  useEffect(() => {
    if (openedProject.current === projectId) return
    openedProject.current = projectId
    markOpened({ id: projectId })
  }, [markOpened, projectId])

  const projectQuery = useQuery(trpc.projects.get.queryOptions({ id: projectId }))
  const capabilitiesQuery = useQuery(trpc.projects.capabilities.queryOptions({ id: projectId }))
  const initializeGit = useMutation(
    trpc.projects.initializeGit.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.projects.capabilities.queryKey({ id: projectId }),
        })
        void queryClient.invalidateQueries({
          queryKey: trpc.projects.get.queryKey({ id: projectId }),
        })
        void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })
      },
    }),
  )
  const gitAvailable = capabilitiesQuery.data?.git === true
  const [nonGitNoticeDismissed, setNonGitNoticeDismissed] = useNonGitNoticeDismissed(projectId)
  const gitDisabledReason = capabilitiesQuery.isError
    ? `${t("Could not check Git availability: ")}${translateKnownError(language, capabilitiesQuery.error.message)}`
    : capabilitiesQuery.isPending
      ? t("Checking Git availability…")
      : t("Initialize Git to run Git-state-aware project routines.")
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const editorSettings: EditorSettings = settingsQuery.data?.editor ?? DEFAULT_EDITOR_SETTINGS

  const updateEditor = useMutation(
    trpc.settings.updateEditor.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() })
      },
    }),
  )
  const setMainFile = useMutation(
    trpc.projects.setDocumentPath.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.projects.get.queryKey() })
        void queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })
      },
    }),
  )
  const onUpdateEditorSettings = (patch: Partial<EditorSettings>) => updateEditor.mutate(patch)

  // The right sidebar defaults to EXPANDED on every project open (session state, keyed by
  // project — not persisted), so opening a project always shows it. Collapsing it (the
  // sidebar's collapse button or the central panel's expand button) lasts for this project
  // view; switching/reopening a project shows it expanded again. Its width when expanded is a
  // separately-persisted, edge-resizable preference.
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(
    () => restoredWorkspaceState?.rightSidebarCollapsed ?? false,
  )
  const [rightSidebarActiveId, setRightSidebarActiveId] = useState<string | null>(
    () => restoredWorkspaceState?.rightSidebarActiveId ?? null,
  )
  const [savedRightSidebarWidth, persistRightSidebarWidth] = useRightSidebarWidth()
  const [rightSidebarWidth, setRightSidebarWidth] = useState(savedRightSidebarWidth)
  useEffect(() => setRightSidebarWidth(savedRightSidebarWidth), [savedRightSidebarWidth])

  // User-pinned `.md` right-sidebar panels, seeded from the restored workspace state
  // and persisted per project so they survive remount and app relaunch.
  const [pinnedPanels, setPinnedPanels] = useState<string[]>(
    () => restoredWorkspaceState?.pinnedPanels ?? [],
  )
  const pinPanel = (relPath: string) =>
    setPinnedPanels((prev) => (prev.includes(relPath) ? prev : [...prev, relPath]))
  const unpinPanel = (relPath: string) =>
    setPinnedPanels((prev) => prev.filter((path) => path !== relPath))

  useEffect(() => {
    writeProjectWorkspaceViewState(projectId, {
      rightSidebarCollapsed,
      rightSidebarActiveId,
      pinnedPanels,
    })
  }, [projectId, rightSidebarActiveId, rightSidebarCollapsed, pinnedPanels])

  // When the left sidebar is collapsed, the traffic lights ride this view's title-bar
  // strip, so the header clears + drags around them (the path text stays selectable).
  const [collapsed] = useSidebarCollapsed()

  // Ensure the project's main-checkout (branch) workspace exists, once on mount
  // (this component is keyed by project, so a switch remounts and re-ensures).
  const ensureMain = useMutation(trpc.workspaces.ensureMain.mutationOptions())
  const ensureMainRef = useRef(ensureMain.mutateAsync)
  ensureMainRef.current = ensureMain.mutateAsync
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [fileFinderRequested, setFileFinderRequested] = useState(false)
  // The project heading appears before its workspace is ready. Keep an early ⌘F
  // request until the central panel can open the file finder.
  useLayoutEffect(() => {
    const requestFileFinder = () => setFileFinderRequested(true)
    window.addEventListener("pi-lab:open-project-file-finder", requestFileFinder)
    return () => window.removeEventListener("pi-lab:open-project-file-finder", requestFileFinder)
  }, [])
  useEffect(() => {
    // Fire on every effect run; only the still-active run applies the result.
    // Under React StrictMode's dev double-invoke the first run is cleaned up
    // (active=false) and the second run is the one that resolves workspaceId;
    // ensureMain is idempotent, so firing it twice is harmless. A "fire once"
    // ref guard instead leaves the second run inert while the first was already
    // cancelled — so workspaceId is never set and the view hangs on
    // "Opening project…" in dev (StrictMode) even though the prod build works.
    let active = true
    ensureMainRef
      .current({ projectId })
      .then((workspace) => {
        if (active) setWorkspaceId(workspace.id)
      })
      .catch(() => {
        // Real errors surface below via ensureMain.isError.
      })
    return () => {
      active = false
    }
  }, [projectId])

  const onStateChange = useCallback(
    (state: CentralPanelRestoreState) => {
      writeProjectWorkspaceState(projectId, state, workspaceId ?? undefined)
    },
    [projectId, workspaceId],
  )
  const onBuffersChange = useCallback(
    (buffers: OpenBuffer[]) => {
      workspaceRecovery().updateBuffers(projectId, () => buffers)
    },
    [projectId],
  )
  useEffect(() => () => workspaceRecovery().flush(projectId), [projectId])
  const retainedBuffers = useMemo<RetainedBuffers>(
    () => ({
      read: () => workspaceRecovery().read(projectId, true)?.buffers ?? [],
      update: (update) => workspaceRecovery().updateBuffers(projectId, update),
    }),
    [projectId],
  )

  // Hooks are unconditional; the central panel does no file I/O until a workspace
  // id is set and the panel is rendered, so an empty id pre-resolve is inert.
  const controller = useCentralPanel({
    client,
    workspaceId: workspaceId ?? "",
    projectId,
    settings: editorSettings,
    initialSession: pendingTaskSession,
    initialState: restoredWorkspaceState,
    onStateChange,
    onBuffersChange,
    retainedBuffers,
  })
  const editorRef = useRef(controller)
  editorRef.current = controller
  useEffect(() => registerProjectEditor(projectId, () => editorRef.current), [projectId])
  const [saveAsError, setSaveAsError] = useState<string | null>(null)

  // Auto-research: open an isolated worktree agent session for the project and
  // attach it so it appears (and is selectable) in the central panel.
  const startAutoResearch = useMutation(trpc.sessions.startAutoResearch.mutationOptions())
  const onAutoResearch = () => {
    startAutoResearch.mutate(
      { projectId },
      {
        onSuccess: (result) =>
          controller.attachSession({
            kind: "agent",
            sessionId: result.sessionId,
            label: "Auto-research",
            launch: { type: "auto-research" },
          }),
      },
    )
  }

  // Run a launch a project card triggered before navigating here, once the main
  // workspace is ready (so a `main`-mode launch reuses the already-ensured branch
  // workspace rather than racing `ensureMain` to create it). The launched session
  // attaches to the central panel above; a failed launch surfaces in the banner
  // below. The ref guard fires it exactly once, independent of the open itself, so
  // the view is never blocked on the launch (no permanent "Opening project…").
  const runPendingLaunch = useRef<() => void>(() => {})
  runPendingLaunch.current = () => {
    if (pendingLaunch?.kind === "auto-research") onAutoResearch()
  }
  const pendingLaunchFired = useRef(false)
  useEffect(() => {
    if (!pendingLaunch || !workspaceId || pendingLaunchFired.current) return
    pendingLaunchFired.current = true
    runPendingLaunch.current()
  }, [pendingLaunch, workspaceId])

  const handledPendingOpenFile = useRef<number | null>(null)
  useEffect(() => {
    if (
      !pendingOpenFile ||
      !workspaceId ||
      handledPendingOpenFile.current === pendingOpenFile.token
    ) {
      return
    }
    handledPendingOpenFile.current = pendingOpenFile.token
    clearPendingOpenFile(projectId, pendingOpenFile.token)
    if (pendingOpenFile.kind === "new") controller.openNewMarkdown()
    else if (pendingOpenFile.relPath) controller.openFile(pendingOpenFile.relPath)
  }, [controller.openFile, controller.openNewMarkdown, pendingOpenFile, projectId, workspaceId])

  // The quick editor saves before switching to this route, then opens that same
  // file as a normal project tab after the main workspace is ready.
  const handledQuickFile = useRef<string | null>(null)
  useEffect(() => {
    if (!workspaceId || !activation.quickFile) return
    const relPath = stripOuterQuery(activation.quickFile)
    if (handledQuickFile.current === relPath) return
    handledQuickFile.current = relPath
    controller.openFile(relPath)
  }, [activation.quickFile, controller.openFile, workspaceId])

  // Card-triggered and in-view auto-research launch failures surface here (no
  // silent failure — AGENTS.md), so a failed launch never leaves the view stuck.
  const launchError = startAutoResearch.error?.message ?? null

  const handledActivation = useRef<string | null>(null)
  useEffect(() => {
    if (
      !activation.notificationId ||
      !activation.notificationSessionId ||
      !activation.notificationKind ||
      handledActivation.current === activation.notificationId
    ) {
      return
    }
    handledActivation.current = activation.notificationId
    controller.attachSession({
      kind: activation.notificationKind,
      sessionId: activation.notificationSessionId,
      label: activation.notificationLabel ?? activation.notificationAgentId ?? "Terminal",
      launch:
        activation.notificationKind === "agent"
          ? {
              type: "agent",
              agentId: activation.notificationAgentId,
              workspaceMode: "policy",
            }
          : { type: "terminal" },
    })
  }, [
    activation.notificationAgentId,
    activation.notificationId,
    activation.notificationKind,
    activation.notificationLabel,
    activation.notificationSessionId,
    controller.attachSession,
  ])

  if (projectQuery.isError) {
    return (
      <div className="p-8">
        <p data-testid="project-error" className="cursor-text select-text text-destructive text-sm">
          {translateKnownError(language, projectQuery.error.message)}
        </p>
      </div>
    )
  }

  const project = projectQuery.data

  return (
    <div data-testid="project-view" className="flex h-full flex-col gap-3 p-4">
      {touchProject.isError ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {t("Could not record this project's recent activity:")} {touchProject.error.message}
        </p>
      ) : null}
      <header
        className={cn(
          "flex items-center justify-between gap-3",
          titleBarInsetHeaderClass(collapsed),
        )}
      >
        <div className={cn("flex min-w-0 flex-col", titleBarControlClass(collapsed))}>
          <h1 className="truncate font-semibold text-foreground text-sm tracking-tight">
            {project?.name ?? t("Loading…")}
          </h1>
          {project ? (
            <p className="cursor-text select-text truncate text-muted-foreground text-xs">
              {project.repoPath}
            </p>
          ) : null}
        </div>
        <div className={cn("flex shrink-0 items-center gap-2", titleBarControlClass(collapsed))}>
          <button
            type="button"
            data-testid="project-view-auto-research"
            aria-busy={startAutoResearch.isPending}
            title={!gitAvailable ? gitDisabledReason : t("Auto research")}
            data-feature-label={t("Auto research")}
            data-feature-help={t(
              "Open an isolated worktree agent session and seed a placeholder AUTORESEARCH.md",
            )}
            disabled={!gitAvailable || !workspaceId || startAutoResearch.isPending}
            onClick={onAutoResearch}
            className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Telescope className="size-3.5 shrink-0" aria-hidden />
            <span>{t("Auto research")}</span>
          </button>
          <ProjectWorkflowControl
            projectId={projectId}
            projectName={project?.name ?? t("Project")}
            task="plan-research"
            variant="labeled"
            testId="project-view-plan-research"
          />
          <AgentStatusControl />
          <CaffeineControl />
        </div>
      </header>

      {capabilitiesQuery.isError ? (
        <section
          data-testid="project-git-capability-error"
          role="alert"
          className="shrink-0 rounded-md border border-destructive/35 bg-destructive/8 px-3 py-2 text-destructive text-xs"
        >
          {t("Could not check Git availability: ")}
          {translateKnownError(language, capabilitiesQuery.error.message)}
        </section>
      ) : null}

      {capabilitiesQuery.data?.git === false && !nonGitNoticeDismissed ? (
        <section
          data-testid="non-git-project-notice"
          style={{ marginRight: rightSidebarCollapsed ? 0 : rightSidebarWidth + 12 }}
          className="flex shrink-0 items-center gap-2 rounded-md border border-amber-500/35 bg-amber-500/8 px-3 py-1.5 text-xs"
        >
          <p className="min-w-0 flex-1 truncate cursor-text select-text text-muted-foreground">
            <span className="font-medium text-foreground">
              {t("This project is not git tracked.")}
            </span>{" "}
            {t("Initialize Git for worktrees and concurrent agents.")}
          </p>
          <button
            type="button"
            onClick={() => initializeGit.mutate({ id: projectId })}
            disabled={initializeGit.isPending}
            className="shrink-0 rounded-md border border-border bg-background px-2 py-1 font-medium text-foreground disabled:opacity-60"
          >
            {initializeGit.isPending ? t("Initializing…") : t("Initialize Git")}
          </button>
          {initializeGit.error ? (
            <span role="alert" className="text-destructive">
              {translateKnownError(language, initializeGit.error.message)}
            </span>
          ) : null}
          <button
            type="button"
            aria-label={t("Dismiss Git notice")}
            title={t("Dismiss Git notice")}
            onClick={() => setNonGitNoticeDismissed(true)}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-amber-500/15 hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </section>
      ) : null}

      {launchError ? (
        <p
          data-testid="project-launch-error"
          className="shrink-0 cursor-text select-text rounded-md border border-border bg-destructive/10 px-4 py-2 text-destructive text-xs"
        >
          {launchError}
        </p>
      ) : null}

      {saveAsError ? (
        <p role="alert" className="text-destructive text-sm">
          {saveAsError}
        </p>
      ) : null}
      {setMainFile.error ? (
        <p role="alert" className="text-destructive text-sm">
          {setMainFile.error.message}
        </p>
      ) : null}
      {workspaceId ? (
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <CentralPanel
              controller={controller}
              client={client}
              workspaceId={workspaceId}
              openFileFinder={fileFinderRequested}
              onFileFinderOpened={() => setFileFinderRequested(false)}
              projectName={project?.name}
              settings={editorSettings}
              gitAvailable={gitAvailable}
              onUpdateEditorSettings={onUpdateEditorSettings}
              rightSidebarCollapsed={rightSidebarCollapsed}
              onExpandRightSidebar={() => setRightSidebarCollapsed(false)}
              onPinFile={pinPanel}
              onSetMainFile={(relPath) =>
                setMainFile.mutate({ id: projectId, kind: "main", relPath })
              }
              onSaveUntitled={
                newFileController
                  ? (relPath) => {
                      void saveProjectBuffer(
                        workspaceRecovery(),
                        client,
                        projectId,
                        relPath,
                        editorSettings,
                        newFileController.chooseNewFile,
                      ).then((result) => setSaveAsError(result.error))
                    }
                  : undefined
              }
            />
          </div>
          {rightSidebarCollapsed ? null : (
            <div className="relative flex min-h-0 shrink-0" style={{ width: rightSidebarWidth }}>
              <EdgeResizeHandle
                side="left"
                width={rightSidebarWidth}
                onResize={setRightSidebarWidth}
                onResizeEnd={persistRightSidebarWidth}
                min={RIGHT_SIDEBAR_MIN_WIDTH}
                max={RIGHT_SIDEBAR_MAX_WIDTH}
                testId="right-sidebar-edge-drag"
              />
              <RightSidebar
                projectId={projectId}
                workspaceId={workspaceId}
                onOpenFile={controller.openFile}
                activeRelPath={controller.editor.active?.relPath ?? null}
                activeId={rightSidebarActiveId}
                onActiveIdChange={setRightSidebarActiveId}
                onCollapse={() => setRightSidebarCollapsed(true)}
                pinnedPanels={pinnedPanels}
                onPinFile={pinPanel}
                onUnpinFile={unpinPanel}
                gitAvailable={gitAvailable}
              />
            </div>
          )}
          <ProjectPalette
            controller={controller}
            workspaceId={workspaceId}
            pinnedPanels={pinnedPanels}
            gitAvailable={gitAvailable}
            onSelectPanel={(panelId) => {
              setRightSidebarActiveId(panelId)
              setRightSidebarCollapsed(false)
            }}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm">
          {ensureMain.isError ? (
            <span data-testid="project-error" className="cursor-text select-text text-destructive">
              {translateKnownError(language, ensureMain.error.message)}
            </span>
          ) : (
            t("Opening project…")
          )}
        </div>
      )}
    </div>
  )
}
