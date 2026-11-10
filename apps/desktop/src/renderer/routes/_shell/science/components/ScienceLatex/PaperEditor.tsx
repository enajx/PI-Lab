import type { EditorSettings } from "@pi-lab/local-db/editor-settings"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PenLine } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { BuildResult } from "../../../../../../main/trpc/pdf/pdf"
import { HeaderShortcuts } from "../../../../../components/HeaderShortcuts/HeaderShortcuts"
import type { OpenBuffer } from "../../../../../Editor/hooks/useEditorBuffers"
import type { RetainedBuffers } from "../../../../../Editor/hooks/useEditorBuffers/useEditorBuffers"
import { useTranslate } from "../../../../../i18n/language"
import {
  readRestoreProjectTabs,
  useLatexEditorFilesOpen,
  useLatexEditorLeftColumn,
  useLatexEditorOutlineOpen,
} from "../../../../../preferences/preferences"
import { useTRPC, useTRPCClient } from "../../../../../trpc/react"
import { registerProjectEditor } from "../../../projects/-workspaceEditorOperations"
import {
  latexWorkspaceKey,
  readProjectWorkspaceState,
  workspaceRecovery,
  writeProjectWorkspaceState,
} from "../../../projects/-workspaceState"
import {
  CentralPanel,
  type CentralPanelController,
  useCentralPanel,
} from "../../../projects/components/CentralPanel"
import { CollapsibleSection } from "../../../projects/components/CentralPanel/CollapsibleSection"
import type { CentralPanelRestoreState } from "../../../projects/components/CentralPanel/useCentralPanel"
import { ConnectOverleafDialog } from "./ConnectOverleaf"
import { LatexEngineStatusItem } from "./LatexEngine"
import { PaperFolderStatusItem } from "./PaperFolder"
import { PaperSyncBar } from "./PaperSyncBar"

interface PaperEditorProps {
  projectId: string
  projectName: string
  /** The paper folder's workspace (kind "paper"). */
  workspaceId: string
  /** The paper folder's full path. */
  paperDir: string
  /** The paper folder as shown to the user (from `paper.get`). */
  displayDir: string
  /** The main .tex file, relative to the paper folder, or null when none was found. */
  rootRelPath: string | null
  lastSyncAt: number | null
  hasRemote: boolean
  /** False when the paper is linked for editing and building only (no Sync). */
  syncEnabled: boolean
  /** This paper's own build output folder, or null when it uses the global default. */
  outputDir: string | null
  /** The build output folder its builds use. */
  effectiveOutputDir: string
  settings: EditorSettings
  onUpdateEditorSettings: (patch: Partial<EditorSettings>) => void
  /** An agent session to focus (and open as a tab when it is not open), or null. */
  focusSession: FocusSessionRequest | null
  /** The page top bar's element that holds the Update paper and Sync buttons, or null before it mounts. */
  syncSlot: HTMLElement | null
  /**
   * Right after Create paper: the build of the main .tex it ran before the
   * editor opened (its PDF then opens beside the source), else null.
   */
  createdBuild: Promise<BuildResult> | null
}

/** A request to show one agent session in the LaTeX Editor, e.g. from the Project Agents box. */
export interface FocusSessionRequest {
  sessionId: string
  agentId: string
  /** Tab label, e.g. "Claude Code". */
  agentLabel: string
}

/**
 * The PDF a root `.tex` builds to: `<root dir>/<output folder>/<root name>.pdf`
 * ("." puts it next to the .tex).
 */
function pdfFor(rootRelPath: string, outputDir: string): string {
  const slash = rootRelPath.lastIndexOf("/")
  const dir = slash < 0 ? "" : rootRelPath.slice(0, slash + 1)
  const name = rootRelPath.slice(slash + 1).replace(/\.tex$/i, "")
  return outputDir === "." ? `${dir}${name}.pdf` : `${dir}${outputDir}/${name}.pdf`
}

/**
 * Whether the open file `relPath` is an earlier build of the same root .tex as
 * `pdfRelPath`, in another output folder: a PDF with the same name, inside the
 * root's folder, at another path.
 */
function isOtherBuildOf(relPath: string, pdfRelPath: string, sourceRelPath: string): boolean {
  if (relPath === pdfRelPath || !/\.pdf$/i.test(relPath)) return false
  const name = (path: string): string => path.slice(path.lastIndexOf("/") + 1)
  const slash = sourceRelPath.lastIndexOf("/")
  const sourceDir = slash < 0 ? "" : sourceRelPath.slice(0, slash + 1)
  return name(relPath) === name(pdfRelPath) && relPath.startsWith(sourceDir)
}

/** The saved LaTeX Editor state, only when it belongs to this paper workspace. */
function restorableState(
  state: ReturnType<typeof readProjectWorkspaceState>,
  workspaceId: string,
): ReturnType<typeof readProjectWorkspaceState> {
  return state?.workspaceId === workspaceId ? state : undefined
}

/** Whether a restored state reopens any file or session tab. */
function hasRestoredTabs(state: ReturnType<typeof readProjectWorkspaceState>): boolean {
  return Boolean(
    state &&
      (state.buffers.length > 0 ||
        (state.omittedBuffers ?? []).length > 0 ||
        state.sessions.length > 0),
  )
}

/**
 * The LaTeX Editor workspace for a linked paper: the editor panel (source and
 * PDF side by side, with build, build log and SyncTeX) whose left column holds
 * the paper folder's file tree with the outline below it, a "Paper folder"
 * item in the editor status bar to change or clear the folder, and the Sync controls
 * (the Sync button in the page top bar; the last sync time, Sync messages and
 * the output folder item in the editor status bar, before the paper folder item).
 * Saving a .tex builds it and opens the built PDF beside the source when it is
 * not open yet (an open PDF reloads itself when the file changes). The footer
 * also has the LaTeX engine item, and the top bar an Update paper button that
 * starts an agent with the write-research skill.
 */
export function PaperEditor({
  projectId,
  projectName,
  workspaceId,
  paperDir,
  displayDir,
  rootRelPath,
  lastSyncAt,
  hasRemote,
  syncEnabled,
  outputDir,
  effectiveOutputDir,
  settings,
  onUpdateEditorSettings,
  focusSession,
  syncSlot,
  createdBuild,
}: PaperEditorProps) {
  const t = useTranslate()
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const outline = useQuery(trpc.paper.outline.queryOptions({ projectId }))
  const [leftColumnOpen, setLeftColumnOpen] = useLatexEditorLeftColumn()
  const [outlineOpen, setOutlineOpen] = useLatexEditorOutlineOpen()
  const [filesOpen, setFilesOpen] = useLatexEditorFilesOpen()
  const [openError, setOpenError] = useState<string | null>(null)
  // The editor footer element the Sync controls put their footer items in.
  const [footerSlot, setFooterSlot] = useState<HTMLElement | null>(null)
  const [connectOpen, setConnectOpen] = useState(false)
  const onSaved = useCallback(
    (relPath: string): void => {
      if (!/\.(tex|bib)$/i.test(relPath)) return
      void queryClient.invalidateQueries({ queryKey: trpc.paper.outline.queryKey({ projectId }) })
    },
    [projectId, queryClient, trpc],
  )
  // The build callback is created before the controller, so it reads it through a ref.
  const controllerRef = useRef<CentralPanelController | null>(null)
  const onBuilt = useCallback((pdfRelPath: string, sourceRelPath: string): void => {
    const panel = controllerRef.current
    if (!panel || panel.editor.tabs.some((tab) => tab.relPath === pdfRelPath)) return
    // A PDF of the same source built into another output folder (the folder was
    // changed) is closed, so the one PDF beside the source is the current one.
    for (const tab of panel.editor.tabs) {
      if (isOtherBuildOf(tab.relPath, pdfRelPath, sourceRelPath)) panel.closeFile(tab.relPath)
    }
    // Open the PDF beside the source and keep the source focused for typing.
    panel.editor.openFile(pdfRelPath).then(
      () => panel.selectFile(sourceRelPath),
      (cause: unknown) => setOpenError(`${pdfRelPath}: ${String(cause)}`),
    )
  }, [])
  // Open tabs and agents are kept per project with the same recovery store as
  // the Project view, under their own key, and only for this paper workspace.
  const stateKey = latexWorkspaceKey(projectId)
  const restoredState = useRef(
    restorableState(readProjectWorkspaceState(stateKey, readRestoreProjectTabs()), workspaceId),
  ).current
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
    projectId,
    origin: "latex",
    settings,
    onSaved,
    onBuilt,
    initialState: restoredState,
    onStateChange,
    onBuffersChange,
    retainedBuffers,
  })
  controllerRef.current = controller
  // Lets the quit dialog save this view's unsaved files through the mounted editor.
  const editorRef = useRef(controller)
  editorRef.current = controller
  useEffect(() => registerProjectEditor(stateKey, () => editorRef.current), [stateKey])

  const [sourceRequest, setSourceRequest] = useState<{
    relPath: string
    line: number
    column: number
    nonce: number
  } | null>(null)

  // Once per paper: open the main .tex (unless tabs from an earlier visit were
  // restored) and show its PDF beside it. A just-created paper shows the build
  // Create paper ran. Otherwise a missing PDF, or one older than the .tex, is
  // built first; `onBuilt` then opens it beside the source. A failed build
  // shows "LaTeX build failed" and its log in the footer.
  const restoredTabs = useRef(hasRestoredTabs(restoredState)).current
  const openedFor = useRef<string | null>(null)
  const openFile = controller.openFile
  const openBuffer = controller.editor.openFile
  const buildLatex = controller.buildLatex
  const showLatexBuild = controller.showLatexBuild
  const attachSession = controller.attachSession
  const focusRequested = useRef(focusSession !== null)
  useEffect(() => {
    if (!rootRelPath || openedFor.current === workspaceId) return
    openedFor.current = workspaceId
    if (!restoredTabs) openFile(rootRelPath)
    // The PDF tab is placed beside the source's tab, so the source opens first.
    const sourceOpened = restoredTabs ? Promise.resolve() : openBuffer(rootRelPath)
    if (createdBuild) {
      sourceOpened.then(
        () => showLatexBuild(rootRelPath, createdBuild),
        (cause: unknown) => setOpenError(`${rootRelPath}: ${String(cause)}`),
      )
      return
    }
    const pdf = pdfFor(rootRelPath, effectiveOutputDir)
    Promise.all([
      client.files.stat.query({ workspaceId, relPath: rootRelPath }),
      client.files.stat.query({ workspaceId, relPath: pdf }),
      sourceOpened,
    ]).then(
      ([source, built]) => {
        if (!built.exists || built.mtimeMs < source.mtimeMs) {
          buildLatex(rootRelPath)
          return
        }
        if (restoredTabs) return
        // A requested agent tab keeps the focus; the PDF still opens beside the source.
        if (focusRequested.current) {
          openBuffer(pdf).then(undefined, (cause: unknown) =>
            setOpenError(`${pdf}: ${String(cause)}`),
          )
        } else openFile(pdf)
      },
      (cause: unknown) => setOpenError(`${pdf}: ${String(cause)}`),
    )
  }, [
    buildLatex,
    client,
    createdBuild,
    effectiveOutputDir,
    openBuffer,
    openFile,
    restoredTabs,
    rootRelPath,
    showLatexBuild,
    workspaceId,
  ])

  // Update paper: an agent with the write-research skill, shown as a focused tab.
  const [updateWarning, setUpdateWarning] = useState<string | null>(null)
  const startUpdate = useMutation(
    trpc.paper.startUpdate.mutationOptions({
      onSuccess: (result) => {
        setUpdateWarning(result.warning)
        attachSession({
          kind: "agent",
          sessionId: result.sessionId,
          label: t("Update paper"),
          wsKind: result.kind,
          launch: { type: "agent", agentId: result.agentId, workspaceMode: "policy" },
        })
      },
      onError: (cause) => setOpenError(cause.message),
    }),
  )

  // Focus a requested agent session once, opening it as a tab when it is not open.
  // This runs after the main .tex opens, so the agent tab ends up focused.
  const focusedRequest = useRef<string | null>(null)
  useEffect(() => {
    if (!focusSession || focusedRequest.current === focusSession.sessionId) return
    focusedRequest.current = focusSession.sessionId
    attachSession({
      kind: "agent",
      sessionId: focusSession.sessionId,
      label: focusSession.agentLabel,
      launch: { type: "agent", agentId: focusSession.agentId, workspaceMode: "policy" },
    })
  }, [attachSession, focusSession])
  const outlineSection = (
    <CollapsibleSection
      title={t("Outline")}
      open={outlineOpen}
      onOpenChange={setOutlineOpen}
      testId="paper-outline-section"
      className={
        // Below an open file tree it takes at most part of the column; alone it fills it.
        outlineOpen
          ? filesOpen
            ? "max-h-[45%] shrink-0 border-border border-t"
            : "flex-1 border-border border-t"
          : "shrink-0 border-border border-t"
      }
    >
      <div className="min-h-0 overflow-y-auto pb-1 text-xs">
        {outline.isError ? (
          <p role="alert" className="px-3 text-destructive">
            {outline.error.message}
          </p>
        ) : outline.data?.length === 0 ? (
          <p className="px-3 text-muted-foreground">{t("No sections")}</p>
        ) : (
          <ul data-testid="paper-outline">
            {outline.data?.map((entry) => (
              <li key={`${entry.relPath}:${entry.line}`}>
                <button
                  type="button"
                  data-testid="paper-outline-entry"
                  title={`${entry.relPath}:${entry.line}`}
                  className="w-full truncate py-1 pr-2 text-left hover:bg-accent"
                  style={{ paddingLeft: `${12 + Math.max(0, entry.level - 2) * 10}px` }}
                  onClick={() =>
                    setSourceRequest({
                      relPath: entry.relPath,
                      line: entry.line,
                      column: 1,
                      nonce: Date.now(),
                    })
                  }
                >
                  {entry.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </CollapsibleSection>
  )

  return (
    <div data-testid="paper-editor" className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {openError ? (
          <p role="alert" className="cursor-text select-text px-3 py-1 text-destructive text-xs">
            {openError}
          </p>
        ) : null}
        {updateWarning ? (
          <p
            data-testid="paper-update-warning"
            className="cursor-text select-text px-3 py-1 text-muted-foreground text-xs"
          >
            {updateWarning}
          </p>
        ) : null}
        <CentralPanel
          controller={controller}
          client={client}
          workspaceId={workspaceId}
          openFileFinder={false}
          onFileFinderOpened={() => undefined}
          projectName={projectName}
          settings={settings}
          onUpdateEditorSettings={onUpdateEditorSettings}
          rightSidebarCollapsed={false}
          onExpandRightSidebar={() => undefined}
          filesPanelOpen={leftColumnOpen}
          onFilesPanelOpenChange={setLeftColumnOpen}
          pdfBesideSource={true}
          sourceRequest={sourceRequest}
          leftColumn={{
            bottom: outlineSection,
            filesOpen,
            onFilesOpenChange: setFilesOpen,
          }}
          paperFolderItem={
            <>
              <div ref={setFooterSlot} data-testid="paper-footer-slot" className="contents" />
              <LatexEngineStatusItem />
              {syncEnabled && !hasRemote ? (
                <button
                  type="button"
                  data-testid="paper-connect-overleaf"
                  title={t("Send this paper to a new Overleaf project")}
                  onClick={() => setConnectOpen(true)}
                  className="shrink-0 rounded px-1 transition-colors hover:bg-accent hover:text-foreground"
                >
                  {t("Connect to Overleaf…")}
                </button>
              ) : null}
              <PaperFolderStatusItem projectId={projectId} dir={paperDir} displayDir={displayDir} />
            </>
          }
        />
      </div>
      {syncSlot
        ? createPortal(
            <HeaderShortcuts
              view="latex"
              projectId={projectId}
              onError={setOpenError}
              onSkillSessionStarted={(session) =>
                attachSession({
                  kind: "agent",
                  sessionId: session.sessionId,
                  label: session.label,
                  wsKind: session.kind,
                  launch: { type: "agent", agentId: session.agentId, workspaceMode: "policy" },
                })
              }
              builtins={[
                {
                  id: "update-paper",
                  label: t("Update paper"),
                  node: (
                    <button
                      type="button"
                      data-testid="paper-update"
                      disabled={startUpdate.isPending}
                      title={t("Start an agent that updates the paper from the project's results")}
                      onClick={() => {
                        setOpenError(null)
                        startUpdate.mutate({ projectId })
                      }}
                      className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs hover:bg-accent disabled:opacity-50"
                    >
                      <PenLine className="size-3.5" aria-hidden />
                      {t("Update paper")}
                    </button>
                  ),
                },
              ]}
            />,
            syncSlot,
          )
        : null}
      <PaperSyncBar
        projectId={projectId}
        workspaceId={workspaceId}
        syncSlot={syncSlot}
        footerSlot={footerSlot}
        lastSyncAt={lastSyncAt}
        hasRemote={hasRemote}
        syncEnabled={syncEnabled}
        confirmCommit={settings.confirmOverleafCommit}
        outputDir={outputDir}
        defaultOutputDir={settings.latexOutputDir}
        saveOpenFiles={async () => {
          const failed: string[] = []
          for (const tab of controller.editor.tabs) {
            if (tab.dirty && !(await controller.editor.saveFile(tab.relPath)))
              failed.push(tab.relPath)
          }
          return failed
        }}
        onOpenFiles={(paths) => {
          for (const relPath of paths) controller.openFile(relPath)
        }}
      />
      {connectOpen ? (
        <ConnectOverleafDialog projectId={projectId} onClose={() => setConnectOpen(false)} />
      ) : null}
    </div>
  )
}
