import type { EditorSettings } from "@pi-lab/local-db/editor-settings"
import { cn } from "@pi-lab/ui"
import type { AddPanelPositionOptions } from "dockview-react"
import {
  Bot,
  CheckCircle2,
  CircleHelp,
  FileText,
  MessageSquare,
  PanelLeft,
  PanelLeftOpen,
  PanelRight,
  Play,
  Plus,
  TerminalSquare,
  X,
} from "lucide-react"
import { lazy, type ReactNode, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react"
import { EdgeResizeHandle } from "../../../../../components/EdgeResizeHandle"
import { CodeMirrorBuffer } from "../../../../../Editor/components/CodeMirrorBuffer"
import { EditorSettingsMenu } from "../../../../../Editor/components/EditorSettingsMenu"
import { EditorStatusBar } from "../../../../../Editor/components/EditorStatusBar"
import type {
  PdfLocation,
  SourceLocation,
} from "../../../../../Editor/components/PdfViewer/PdfViewer"
import { QuickOpen } from "../../../../../Editor/components/QuickOpen"
import type { EditorBuffersApi } from "../../../../../Editor/hooks/useEditorBuffers"
import { isPythonPath } from "../../../../../Editor/utils/pythonDiagnostics"
import { rejectedReadMessage } from "../../../../../Editor/utils/rejectedRead"
import { useTranslate } from "../../../../../i18n/language"
import {
  FILES_PANEL_MAX_WIDTH,
  FILES_PANEL_MIN_WIDTH,
  useFilesPanelWidth,
} from "../../../../../preferences/preferences"
import { eventMatchesShortcut } from "../../../../../shortcuts/shortcuts"
import { Terminal } from "../../../../../Terminal"
import type { PiLabTrpcClient } from "../../../../../trpc/client"
import { KindBadge } from "../KindBadge"
import { FilesPanel } from "../RightSidebar/components/FilesPanel"
import { type DockItem, fileItemId, SplitDock, type SplitDockHandle } from "../SplitDock/SplitDock"
import { CloseFilePrompt, useCloseFilePrompt } from "./CloseFilePrompt"
import type { CentralPanelController, SessionPane } from "./useCentralPanel"

/** A new Run tab per run, so each run is placed below the split of the file that ran. */
function runItemId(sessionId: string): string {
  return `run:${sessionId}`
}
const IS_MAC = /Mac/.test(navigator.platform)

const PdfViewer = lazy(() =>
  import("../../../../../Editor/components/PdfViewer/PdfViewer").then((module) => ({
    default: module.PdfViewer,
  })),
)

interface CentralPanelProps {
  controller: CentralPanelController
  /** App-wide tRPC client for the terminal panes' observable subscriptions. */
  client: PiLabTrpcClient
  /** Main-checkout workspace — drives quick-open search + file reads. */
  workspaceId: string
  openFileFinder: boolean
  onFileFinderOpened: () => void
  /** Project name used by the contextual fuzzy-search scope label. */
  projectName?: string
  settings: EditorSettings
  gitAvailable?: boolean
  onUpdateEditorSettings: (patch: Partial<EditorSettings>) => void
  /** When the right sidebar is collapsed, the panel toolbar shows a button to
   * bring it back (the sidebar isn't mounted to host its own expand affordance). */
  rightSidebarCollapsed: boolean
  onExpandRightSidebar: () => void
  /** Whether this project shows the left Files column (per-project state owned by the route). */
  filesPanelOpen: boolean
  onFilesPanelOpenChange: (open: boolean) => void
  /**
   * Pin a `.md` file as a right-sidebar panel. Threaded down to the left Files
   * panel's tree so its right-click "Pin as panel" entry works in this layout too
   * (the right-sidebar Files tab is hidden while the left panel is on).
   */
  onPinFile?: (relPath: string) => void
  onSetMainFile?: (relPath: string) => void
  onSaveUntitled?: (relPath: string) => void
}

/**
 * The project view's central panel. A single bounded slot that holds whatever the user opens — a running
 * agent, a plain terminal, or a file in the built-in editor — with a tab strip
 * (agents, terminals, and open files as peer tabs) and a "+" launcher. Exactly
 * one pane fills the panel; the file tree lives in the right sidebar (or, when
 * the left Files panel is toggled on, in a column down the left of this panel)
 * and opens files here via the controller.
 */
export function CentralPanel({
  controller,
  client,
  workspaceId,
  openFileFinder,
  onFileFinderOpened,
  projectName,
  settings,
  gitAvailable,
  onUpdateEditorSettings,
  rightSidebarCollapsed,
  onExpandRightSidebar,
  filesPanelOpen: showFilesPanel,
  onFilesPanelOpenChange: setShowFilesPanel,
  onPinFile,
  onSetMainFile,
  onSaveUntitled,
}: CentralPanelProps) {
  const t = useTranslate()
  const { editor, sessions, active } = controller
  const [quickOpen, setQuickOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement | null>(null)
  const [filesWidth, setFilesWidth] = useFilesPanelWidth()
  const runDestination = settings.pythonRunDestination ?? "central"

  // The project view keeps an early ⌘F request while the workspace loads.
  useLayoutEffect(() => {
    if (!openFileFinder) return
    setQuickOpen(true)
    onFileFinderOpened()
  }, [openFileFinder, onFileFinderOpened])

  useEffect(() => {
    if (!addMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [addMenuOpen])

  // The Run tab is not a controller tab, so the panel tracks when it has focus. Any
  // controller focus change (another tab selected or opened) moves focus off it.
  const [runFocused, setRunFocused] = useState(false)
  const [layoutRestoreError, setLayoutRestoreError] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset whenever the controller's focus changes.
  useEffect(() => setRunFocused(false), [active])
  const belowEditorRun = controller.belowEditorRun
  const runFocusedNow = runFocused && belowEditorRun !== null

  // Tab ×, Ctrl+W and macOS Cmd+W (from the native menu) close a file tab, asking
  // first when it has unsaved changes. Cmd+W with no file tab focused moves the app
  // to the background instead.
  const closeFilePrompt = useCloseFilePrompt({
    controller,
    runFocused: runFocusedNow,
    onSaveUntitled,
  })

  // Ctrl+W closes the active tab.
  const closeActiveTabRef = useRef(controller.closeActiveTab)
  closeActiveTabRef.current = runFocusedNow
    ? controller.closeBelowEditorRun
    : active?.type === "file"
      ? () => closeFilePrompt.requestClose(active.relPath)
      : controller.closeActiveTab
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "w"
      ) {
        event.preventDefault()
        closeActiveTabRef.current()
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])

  // Split shortcuts (⌘D right, ⇧⌘D down) split a focused terminal: a new terminal opens in
  // a new split. They run in the capture phase so the terminal never sees the key; on any
  // other tab the key is left alone (⌘D stays "select next match" in the editor).
  const dock = useRef<SplitDockHandle>(null)
  /** Split the focused terminal; returns false (doing nothing) when no terminal has focus. */
  const splitFocusedRef = useRef<(direction: "right" | "below") => boolean>(() => false)
  // The finder or agent chooser is open: the shortcut would split behind it.
  const splitBlocked = quickOpen || controller.agentChooserOpen
  splitFocusedRef.current = (direction) => {
    if (splitBlocked || runFocusedNow || active?.type !== "session") return false
    const session = sessions.find((pane) => pane.id === active.id)
    if (session?.kind !== "terminal" || !dock.current?.splitFocused(direction)) return false
    controller.openTerminal()
    return true
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Ctrl+D must still reach terminals as end-of-input: on macOS Ctrl never counts as
      // Mod here, and elsewhere (where Mod is Ctrl) a terminal keeps Ctrl keys.
      if (IS_MAC && event.ctrlKey && !event.metaKey) return
      const target = event.target instanceof Element ? event.target : null
      if (!IS_MAC && event.ctrlKey && target?.closest(".xterm")) return
      // Text fields (Settings shortcut recorder, finder input) keep their keys; xterm's
      // hidden input textarea does not count as one.
      if (target?.closest("input, textarea, select") && !target.closest(".xterm")) return
      const direction = eventMatchesShortcut(event, "split-right")
        ? "right"
        : eventMatchesShortcut(event, "split-down")
          ? "below"
          : null
      if (!direction || !splitFocusedRef.current(direction)) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])

  const [pdfLocation, setPdfLocation] = useState<PdfLocation | null>(null)
  const [sourceLocation, setSourceLocation] = useState<SourceLocation | null>(null)
  const navigateSource = (location: SourceLocation): void => {
    setSourceLocation(location)
    void editor.openFile(location.relPath).then(() => controller.selectFile(location.relPath))
  }
  const navigatePdf = (location: PdfLocation): void => {
    setPdfLocation(location)
    controller.openFile(location.relPath)
  }
  // Per-file view state shown in the single panel status bar, whichever split has focus.
  const [markdownModes, setMarkdownModes] = useState<Record<string, "render" | "source">>({})
  const [pdfMessages, setPdfMessages] = useState<Record<string, string>>({})
  const cursors = useRef<Record<string, { line: number; column: number }>>({})
  const [syncError, setSyncError] = useState<string | null>(null)
  const markdownModeFor = (relPath: string): "render" | "source" | undefined =>
    isMarkdownPath(relPath) ? (markdownModes[relPath] ?? "render") : undefined
  /** Both the status bar button and the source double-click navigate from a source position. */
  const showInPdf = (relPath: string, line: number, column: number): void => {
    setSyncError(null)
    void client.pdf.forwardSync
      .mutate({ workspaceId, relPath, line, column })
      .then(navigatePdf)
      .catch((cause: unknown) => setSyncError(String(cause)))
  }
  const hasFileActive = active?.type === "file" && editor.active !== null
  const hasPythonActive =
    hasFileActive && editor.active !== null && isPythonPath(editor.active.relPath)

  const dockItems: DockItem[] = [
    ...sessions.map(
      (session): DockItem => ({
        id: `session:${session.id}`,
        tab: ({ visible, activate }) => (
          <CentralTab
            kind={session.kind}
            label={session.label}
            badge={
              session.kind === "agent" && session.wsKind ? (
                <KindBadge kind={session.wsKind} />
              ) : undefined
            }
            active={visible}
            onSelect={activate}
            onClose={() => controller.closeSession(session.id)}
          />
        ),
        content: () => (
          <div
            data-testid="central-session"
            data-session-kind={session.kind}
            className="flex min-h-0 flex-1 flex-col"
          >
            <Terminal
              key={session.sessionId}
              client={client}
              inputKind={session.kind}
              sessionId={session.sessionId}
            />
          </div>
        ),
      }),
    ),
    ...editor.tabs.map(
      (tab): DockItem => ({
        id: fileItemId(tab.relPath),
        tab: ({ visible, activate }) => (
          <CentralTab
            kind="file"
            label={basename(tab.relPath)}
            dirty={tab.dirty}
            active={visible}
            onSelect={activate}
            onClose={() => closeFilePrompt.requestClose(tab.relPath)}
          />
        ),
        content: ({ visible }) =>
          editor.buffers.find((buffer) => buffer.relPath === tab.relPath)?.kind === "pdf" ? (
            <Suspense
              fallback={<p className="p-4 text-muted-foreground text-xs">Loading PDF viewer…</p>}
            >
              <PdfViewer
                client={client}
                workspaceId={workspaceId}
                relPath={tab.relPath}
                location={pdfLocation}
                onSource={navigateSource}
                build={controller.pdfBuildState ?? null}
                onMessage={(message) =>
                  setPdfMessages((current) =>
                    current[tab.relPath] === message
                      ? current
                      : { ...current, [tab.relPath]: message },
                  )
                }
              />
            </Suspense>
          ) : (
            <FileSurface
              relPath={tab.relPath}
              shown={visible}
              hasFocus={
                !runFocusedNow && active?.type === "file" && editor.activeRelPath === tab.relPath
              }
              editor={editor}
              settings={settings}
              onRunPython={() => controller.runPython(runDestination)}
              client={client}
              workspaceId={workspaceId}
              onSaveUntitled={onSaveUntitled}
              sourceLocation={sourceLocation}
              markdownMode={markdownModeFor(tab.relPath)}
              onCursorChange={(line, column) => {
                cursors.current[tab.relPath] = { line, column }
              }}
              onShowInPdf={
                isTexPath(tab.relPath)
                  ? (line, column) => showInPdf(tab.relPath, line, column)
                  : undefined
              }
            />
          ),
      }),
    ),
    ...(belowEditorRun
      ? [
          {
            id: runItemId(belowEditorRun.sessionId),
            tab: ({ visible, activate }) => (
              <CentralTab
                kind="terminal"
                label={belowEditorRun.label}
                active={visible}
                onSelect={activate}
                onClose={controller.closeBelowEditorRun}
              />
            ),
            content: () => (
              <div data-testid="editor-run-terminal" className="flex min-h-0 flex-1 flex-col">
                <Terminal
                  key={belowEditorRun.sessionId}
                  client={client}
                  inputKind="terminal"
                  sessionId={belowEditorRun.sessionId}
                />
              </div>
            ),
          } satisfies DockItem,
        ]
      : []),
  ]
  const focusedFile = !runFocusedNow && active?.type === "file" ? editor.active : null
  const focusedSession =
    !runFocusedNow && active?.type === "session"
      ? sessions.find((session) => session.id === active.id)
      : undefined
  const focusedLabel = runFocusedNow
    ? (belowEditorRun?.label ?? null)
    : focusedFile
      ? focusedFile.relPath
      : (focusedSession?.label ?? null)
  const statusBar =
    focusedLabel === null ? null : (
      <EditorStatusBar
        label={focusedLabel}
        pdfMessage={focusedFile?.kind === "pdf" ? pdfMessages[focusedFile.relPath] : null}
        onShowInPdf={
          focusedFile && isTexPath(focusedFile.relPath)
            ? () => {
                const cursor = cursors.current[focusedFile.relPath] ?? { line: 1, column: 1 }
                showInPdf(focusedFile.relPath, cursor.line, cursor.column)
              }
            : undefined
        }
        syncError={focusedFile && isTexPath(focusedFile.relPath) ? syncError : null}
        latexBuildStatus={
          focusedFile && (focusedFile.kind === "pdf" || isTexPath(focusedFile.relPath))
            ? (controller.latexBuildStatus ?? null)
            : null
        }
        isPython={focusedFile ? isPythonPath(focusedFile.relPath) : false}
        counts={editor.statusCounts}
        missing={editor.statusMissing}
        checking={editor.activeDiagnostics.checking}
        hasRun={editor.activeDiagnostics.hasRun}
        outdated={editor.activeDiagnostics.outdated}
        onRefreshDiagnostics={() => void editor.refreshDiagnostics()}
        diagnosticsEnabled={settings.diagnosticsEnabled}
        onToggleDiagnostics={() =>
          onUpdateEditorSettings({ diagnosticsEnabled: !settings.diagnosticsEnabled })
        }
        pythonRuntime={editor.pythonRuntime}
        listPythonEnvironments={editor.listPythonEnvironments}
        selectPythonEnvironment={editor.selectPythonEnvironment}
        choosePythonEnvironment={editor.choosePythonEnvironment}
        markdownMode={focusedFile ? markdownModeFor(focusedFile.relPath) : undefined}
        onMarkdownModeChange={
          focusedFile
            ? (mode) => setMarkdownModes((current) => ({ ...current, [focusedFile.relPath]: mode }))
            : undefined
        }
      />
    )
  const activeDockId =
    runFocusedNow && belowEditorRun
      ? runItemId(belowEditorRun.sessionId)
      : active?.type === "file"
        ? fileItemId(active.relPath)
        : active?.type === "session"
          ? `session:${active.id}`
          : null
  const activateDockItem = (id: string): void => {
    setRunFocused(id.startsWith("run:"))
    if (id.startsWith("file:")) controller.selectFile(id.slice("file:".length))
    else if (id.startsWith("session:")) controller.selectSession(id.slice("session:".length))
  }
  // Run output opens below the split showing the file that ran.
  const dockPlacement = (id: string): AddPanelPositionOptions | undefined => {
    const ranFrom = belowEditorRun?.relPath
    if (
      !belowEditorRun ||
      id !== runItemId(belowEditorRun.sessionId) ||
      !ranFrom ||
      !editor.tabs.some((tab) => tab.relPath === ranFrom)
    ) {
      return undefined
    }
    return { referencePanel: fileItemId(ranFrom), direction: "below" }
  }

  const openFile = (relPath: string) => {
    setQuickOpen(false)
    controller.openFile(relPath)
  }

  return (
    <section
      data-testid="central-panel"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border"
      onBlurCapture={editor.onBlurCapture}
    >
      <div className="flex shrink-0 items-stretch border-border border-b bg-muted/30">
        {/* Files-panel toggle — upper left. */}
        <div className="flex shrink-0 items-center border-border border-r px-1">
          <button
            type="button"
            data-testid="central-files-toggle"
            aria-pressed={showFilesPanel}
            aria-label={showFilesPanel ? t("Hide files panel") : t("Show files panel")}
            title={showFilesPanel ? t("Hide files panel") : t("Show files panel")}
            data-feature-help={t(
              "Show the project file tree beside the editor instead of in the right sidebar",
            )}
            onClick={() => setShowFilesPanel(!showFilesPanel)}
            className={cn(
              "flex size-7 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground",
              showFilesPanel ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {showFilesPanel ? (
              <PanelLeftOpen className="size-4" aria-hidden />
            ) : (
              <PanelLeft className="size-4" aria-hidden />
            )}
          </button>
        </div>

        {/* Tabs live in each split's own tab bar below; this row keeps the shared buttons. */}
        <div className="min-w-0 flex-1" />

        {/* Pane creation, file run, and editor settings — intentionally grouped. */}
        <div className="flex shrink-0 items-center gap-0.5 border-border border-s bg-muted/30 px-1">
          <div ref={addMenuRef} className="relative">
            <button
              type="button"
              data-testid="central-add-menu"
              title={t("Add pane")}
              aria-label={t("Add pane")}
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              onClick={() => setAddMenuOpen((open) => !open)}
              className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-4" aria-hidden />
            </button>
            {addMenuOpen ? (
              <div
                data-testid="central-add-menu-options"
                role="menu"
                className="absolute top-8 end-0 z-30 w-36 rounded-md border border-border bg-popover p-1 shadow-lg"
              >
                <AddMenuButton
                  testId="central-add-agent"
                  label="Agent CLI"
                  icon={<Bot className="size-3.5" aria-hidden />}
                  onClick={() => {
                    setAddMenuOpen(false)
                    controller.openAgentChooser()
                  }}
                />
                <AddMenuButton
                  testId="central-add-terminal"
                  label="Terminal"
                  icon={<TerminalSquare className="size-3.5" aria-hidden />}
                  onClick={() => {
                    setAddMenuOpen(false)
                    controller.openTerminal()
                  }}
                />
                <AddMenuButton
                  testId="central-add-document"
                  label="Document"
                  icon={<FileText className="size-3.5" aria-hidden />}
                  onClick={() => {
                    setAddMenuOpen(false)
                    controller.openNewMarkdown()
                  }}
                />
              </div>
            ) : null}
          </div>
          <button
            type="button"
            data-testid="central-new-agent"
            title={t("New agent")}
            aria-label={t("New agent")}
            data-feature-help={t("Start the remembered coding agent in this project workspace")}
            disabled={controller.pendingAgent}
            onClick={controller.openAgent}
            className={cn(
              "flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              controller.pendingAgent && "cursor-not-allowed opacity-50",
            )}
          >
            <Bot className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            data-testid="central-new-terminal"
            title={t("New terminal")}
            aria-label={t("New terminal")}
            data-feature-help={t("Open an interactive shell in this project workspace")}
            disabled={controller.pendingTerminal}
            onClick={controller.openTerminal}
            className={cn(
              "flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              controller.pendingTerminal && "cursor-not-allowed opacity-50",
            )}
          >
            <TerminalSquare className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            data-testid="central-new-markdown"
            title={t("New markdown")}
            aria-label={t("New markdown")}
            data-feature-help={t("Create an untitled Markdown file in the built-in editor")}
            onClick={controller.openNewMarkdown}
            className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FileText className="size-4" aria-hidden />
          </button>
          {hasPythonActive ? (
            <>
              <ToolbarDivider testId="central-run-divider" />
              <button
                type="button"
                data-testid="central-run-python"
                title={t("Run Python (Mod+Enter)")}
                aria-label={t("Run Python")}
                data-feature-help={t(
                  "Save, format, and run the focused Python file using the destination selected in Editor settings",
                )}
                disabled={controller.pendingPython}
                onClick={() => controller.runPython(runDestination)}
                className={cn(
                  "flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  controller.pendingPython && "cursor-not-allowed opacity-50",
                )}
              >
                <Play className="size-4" aria-hidden />
              </button>
            </>
          ) : null}
          <ToolbarDivider testId="central-settings-divider" />
          <EditorSettingsMenu settings={settings} onChange={onUpdateEditorSettings} />
          {rightSidebarCollapsed ? (
            <button
              type="button"
              data-testid="right-sidebar-expand"
              aria-label={t("Expand panel")}
              title={t("Expand panel")}
              data-feature-help={t("Restore the project details sidebar")}
              onClick={onExpandRightSidebar}
              className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <PanelRight className="size-4" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>

      {controller.launchError ? (
        <p
          data-testid="central-error"
          className="shrink-0 cursor-text select-text border-border border-b bg-destructive/10 px-4 py-2 text-destructive text-xs"
        >
          {controller.launchError}
        </p>
      ) : null}

      {/* Editor open/save errors live at the panel level so a failed file-open is
          visible even when the body has fallen back to the launcher (no silent
          failures — AGENTS.md). */}
      {layoutRestoreError ? (
        <p
          data-testid="central-layout-error"
          className="flex shrink-0 cursor-text select-text items-center gap-2 border-border border-b bg-destructive/10 px-4 py-2 text-destructive text-xs"
        >
          <span className="min-w-0 flex-1">{layoutRestoreError}</span>
          <button
            type="button"
            className="shrink-0 underline"
            onClick={() => setLayoutRestoreError(null)}
          >
            {t("Dismiss")}
          </button>
        </p>
      ) : null}

      {editor.error ? (
        <p
          data-testid="editor-error"
          className="shrink-0 cursor-text select-text border-border border-b bg-destructive/10 px-4 py-2 text-destructive text-xs"
        >
          {editor.error}
        </p>
      ) : null}

      {editor.rejectedRead ? (
        <div
          data-testid="editor-rejected-read"
          className="shrink-0 border-border border-b px-4 py-2 text-sm"
        >
          <p>{rejectedReadMessage(editor.rejectedRead)}</p>
          <button
            type="button"
            className="underline"
            onClick={() => void editor.revealRejectedRead()}
          >
            {t("Reveal in Finder")}
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* Optional left Files column: the workspace tree beside the editor area
            instead of in the right sidebar. It has its own bounded scroll region. */}
        {showFilesPanel ? (
          <div className="relative flex min-h-0 shrink-0" style={{ width: filesWidth }}>
            <div
              data-testid="central-files-panel"
              className="flex min-h-0 w-full flex-col overflow-y-auto border-border border-r"
            >
              <FilesPanel
                workspaceId={workspaceId}
                onOpenFile={controller.openFile}
                activeRelPath={editor.active?.relPath}
                onPinFile={onPinFile}
                onSetMainFile={onSetMainFile}
                editorTabs={{ tabs: editor.tabs, closeFile: controller.closeFile }}
              />
            </div>
            <EdgeResizeHandle
              side="right"
              width={filesWidth}
              onResize={setFilesWidth}
              min={FILES_PANEL_MIN_WIDTH}
              max={FILES_PANEL_MAX_WIDTH}
              testId="central-files-edge-drag"
            />
          </div>
        ) : null}

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <SplitDock
            handle={dock}
            initialLayout={controller.initialLayout}
            onLayoutChange={controller.setLayout}
            onRestoreFailed={(message) =>
              setLayoutRestoreError(`Could not restore the saved split layout: ${message}`)
            }
            items={dockItems}
            activeId={activeDockId}
            onActivate={activateDockItem}
            onOpenDroppedFile={controller.openFile}
            restoringIds={controller.restoringRelPaths.map(fileItemId)}
            placementFor={dockPlacement}
            empty={
              <Launcher
                onOpenAgent={controller.openAgentChooser}
                onOpenTerminal={controller.openTerminal}
                onOpenFile={() => setQuickOpen(true)}
                pendingAgent={controller.pendingAgent}
                pendingTerminal={controller.pendingTerminal}
              />
            }
          />
          {statusBar}
        </div>
      </div>

      {closeFilePrompt.prompt ? (
        <CloseFilePrompt
          prompt={closeFilePrompt.prompt}
          onChoose={(choice) => void closeFilePrompt.choose(choice)}
        />
      ) : null}
      {quickOpen ? (
        <QuickOpen
          workspaceId={workspaceId}
          projectName={projectName}
          onOpenFile={openFile}
          onClose={() => setQuickOpen(false)}
        />
      ) : null}
      {controller.agentChooserOpen ? (
        <NewAgentDialog
          key={controller.preferredAgentId}
          agents={controller.agentOptions}
          initialAgentId={controller.preferredAgentId}
          pending={controller.pendingAgent}
          error={controller.launchError}
          gitAvailable={gitAvailable !== false}
          onStart={controller.launchChosenAgent}
          onClose={controller.closeAgentChooser}
        />
      ) : null}
    </section>
  )
}

function AddMenuButton({
  testId,
  label,
  icon,
  onClick,
}: {
  testId: string
  label: string
  icon: ReactNode
  onClick: () => void
}) {
  const t = useTranslate()
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
    >
      {icon}
      {t(label)}
    </button>
  )
}

function ToolbarDivider({ testId }: { testId: string }) {
  return <div aria-hidden="true" data-testid={testId} className="mx-1 h-4 w-px bg-border" />
}

function NewAgentDialog({
  agents,
  initialAgentId,
  pending,
  error,
  gitAvailable,
  onStart,
  onClose,
}: {
  agents: CentralPanelController["agentOptions"]
  initialAgentId: string
  pending: boolean
  error: string | null
  gitAvailable: boolean
  onStart: (agentId: string, workspaceMode: "main" | "worktree") => void
  onClose: () => void
}) {
  const t = useTranslate()
  const firstAvailable = agents.find((agent) => agent.available)?.id ?? ""
  const initial = agents.some((agent) => agent.id === initialAgentId && agent.available)
    ? initialAgentId
    : firstAvailable
  const [selected, setSelected] = useState(initial)
  const [workspaceMode, setWorkspaceMode] = useState<"main" | "worktree">("main")
  const selectedAvailable = agents.some((agent) => agent.id === selected && agent.available)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  return (
    <div
      data-testid="new-agent-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-agent-title"
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/75 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-background shadow-xl">
        <div className="flex items-start justify-between border-border border-b p-4">
          <div>
            <h2 id="new-agent-title" className="font-semibold text-sm">
              {t("New session")}
            </h2>
            <p className="mt-1 text-muted-foreground text-xs">
              {gitAvailable
                ? t("Start a CLI coding agent in the project’s main checkout or its own worktree.")
                : t(
                    "Start one CLI coding agent in this folder. Initialize Git to use worktrees or concurrent agents.",
                  )}
            </p>
          </div>
          <button type="button" aria-label={t("Close new session")} onClick={onClose}>
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 border-border border-b p-3">
          <button type="button" className="rounded border border-primary bg-primary/10 p-2 text-xs">
            <Bot className="mx-auto mb-1 size-4" aria-hidden />
            {t("Agent CLI")}
          </button>
          <button
            type="button"
            disabled
            className="rounded border border-border p-2 text-muted-foreground text-xs opacity-50"
          >
            <MessageSquare className="mx-auto mb-1 size-4" aria-hidden />
            {t("Chat")}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 p-4">
          {agents.map((agent) => (
            <label
              key={agent.id}
              data-available={agent.available}
              className={cn(
                "flex rounded-lg border p-3",
                agent.available
                  ? selected === agent.id
                    ? "cursor-pointer border-primary bg-primary/5"
                    : "cursor-pointer border-border hover:bg-accent/40"
                  : "border-border opacity-50",
              )}
            >
              <input
                type="radio"
                name="agent"
                aria-label={agent.label}
                value={agent.id}
                checked={selected === agent.id}
                disabled={!agent.available}
                onChange={() => setSelected(agent.id)}
                className="sr-only"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-3 text-sm">
                  {agent.label}
                  {agent.available ? (
                    <CheckCircle2 className="size-4 text-emerald-600" aria-label={t("Detected")} />
                  ) : (
                    <CircleHelp
                      className="size-4 text-muted-foreground"
                      aria-label={t("Not detected")}
                    />
                  )}
                </span>
                <span
                  className={cn(
                    "mt-1 block text-xs",
                    agent.available ? "text-emerald-600" : "text-muted-foreground",
                  )}
                >
                  {agent.available ? t("Detected") : t("Not detected")}
                </span>
              </span>
            </label>
          ))}
          {agents.length === 0 ? (
            <p className="text-destructive text-xs">{t("No agent harnesses are configured.")}</p>
          ) : null}
          <fieldset className="col-span-2 grid grid-cols-2 gap-2 border-border border-t pt-3">
            <legend className="mb-2 text-muted-foreground text-xs">{t("Run agent in")}</legend>
            <label
              className={cn(
                "cursor-pointer rounded-md border p-2 text-sm",
                workspaceMode === "main" ? "border-primary bg-primary/5" : "border-border",
              )}
            >
              <input
                type="radio"
                name="agent-workspace"
                aria-label={t("Main")}
                value="main"
                checked={workspaceMode === "main"}
                onChange={() => setWorkspaceMode("main")}
                className="sr-only"
              />
              {t("Main")}
              <span className="mt-0.5 block text-muted-foreground text-xs">
                {t("Project checkout")}
              </span>
            </label>
            <label
              className={cn(
                "rounded-md border p-2 text-sm",
                gitAvailable ? "cursor-pointer" : "cursor-not-allowed opacity-50",
                workspaceMode === "worktree" ? "border-primary bg-primary/5" : "border-border",
              )}
            >
              <input
                type="radio"
                name="agent-workspace"
                aria-label={t("Worktree")}
                value="worktree"
                checked={workspaceMode === "worktree"}
                disabled={!gitAvailable}
                onChange={() => setWorkspaceMode("worktree")}
                className="sr-only"
              />
              {t("Worktree")}
              <span className="mt-0.5 block text-muted-foreground text-xs">
                {t("Isolated checkout")}
              </span>
            </label>
          </fieldset>
          {error ? (
            <p data-testid="new-agent-error" className="text-destructive text-xs">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-border border-t p-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm hover:bg-accent"
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            disabled={!selectedAvailable || pending}
            onClick={() => onStart(selected, workspaceMode)}
            className="rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm disabled:opacity-50"
          >
            {t("Start agent")}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The editor body for the active file: banners + buffer + status bar. */
function FileSurface({
  relPath,
  editor,
  settings,
  onRunPython,
  client,
  workspaceId,
  onSaveUntitled,
  sourceLocation,
  markdownMode,
  onCursorChange,
  onShowInPdf,
  hasFocus,
  shown,
}: {
  /** The file this surface shows; each split's file tab has its own surface. */
  relPath: string
  /** This file's tab is the focused tab, so its editor may take the keyboard. */
  hasFocus: boolean
  /** This file's tab is the one shown in its split. */
  shown: boolean
  editor: EditorBuffersApi
  settings: EditorSettings
  onRunPython: () => void
  client: PiLabTrpcClient
  workspaceId: string
  onSaveUntitled?: (relPath: string) => void
  sourceLocation: SourceLocation | null
  /** Set for Markdown files; the panel status bar switches it. */
  markdownMode: "render" | "source" | undefined
  onCursorChange: (line: number, column: number) => void
  /** Set for LaTeX sources: double-clicking text shows that position in the PDF. */
  onShowInPdf: ((line: number, column: number) => void) | undefined
}) {
  const t = useTranslate()
  const active = editor.buffers.find((buffer) => buffer.relPath === relPath) ?? null
  // Diagnostics follow the focused file, so only the focused split shows them.
  const focused = editor.activeRelPath === relPath
  if (active?.kind === "pdf") return null
  return (
    <>
      {active?.externalChange ? (
        <div
          data-testid="editor-external-warning"
          className="flex shrink-0 items-center gap-2 border-border border-b bg-amber-500/10 px-4 py-2 text-amber-600 text-xs dark:text-amber-400"
        >
          <span className="select-text">
            {active.relPath}
            {t(" changed on disk while you were editing. Autosave is paused.")}
          </span>
          <button
            type="button"
            className="shrink-0 underline"
            onClick={() => {
              void editor.overwriteFile(active.relPath)
            }}
          >
            {t("Overwrite disk")}
          </button>
          <button
            type="button"
            className="shrink-0 underline"
            onClick={() => {
              void editor.reloadFile(active.relPath)
            }}
          >
            {t("Reload from disk")}
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        {active ? (
          <CodeMirrorBuffer
            autoFocus={hasFocus}
            shown={shown}
            key={`${active.relPath}#${active.epoch}`}
            relPath={active.relPath}
            initialDoc={active.content}
            onCursorChange={onCursorChange}
            onDoubleClickPosition={onShowInPdf}
            sourceLocation={sourceLocation?.relPath === active.relPath ? sourceLocation : null}
            onChange={(doc) => editor.onEdit(active.relPath, doc)}
            onSave={() => {
              if (/^untitled(?:-\d+)?\.md$/i.test(active.relPath)) {
                onSaveUntitled?.(active.relPath)
                return
              }
              void editor.saveFile(active.relPath)
            }}
            onRun={isPythonPath(active.relPath) ? onRunPython : undefined}
            vim={settings.vim}
            theme={settings.editorTheme}
            customThemes={settings.customEditorThemes ?? []}
            diagnostics={focused ? editor.diagnosticsSource : undefined}
            markdownMode={markdownMode}
            searchProjectFiles={
              markdownMode
                ? async (query) => {
                    const result = await client.files.search.query({
                      workspaceId,
                      query,
                      limit: 50,
                    })
                    return result.hits.map(({ relPath }) => ({
                      relPath,
                      name: relPath.split("/").at(-1) ?? relPath,
                      kind: "file" as const,
                    }))
                  }
                : undefined
            }
          />
        ) : null}
      </div>
    </>
  )
}

function isTexPath(relPath: string): boolean {
  return /\.tex$/i.test(relPath)
}

function isMarkdownPath(relPath: string): boolean {
  return /\.(?:md|markdown|mdx)$/i.test(relPath)
}

interface CentralTabProps {
  kind: SessionPane["kind"] | "file"
  label: string
  active: boolean
  dirty?: boolean
  /** Optional trailing badge (the worktree-policy kind badge for agent tabs). */
  badge?: ReactNode
  onSelect: () => void
  onClose: () => void
}

/** One central-panel tab: kind icon, label, a dirty dot for files, close button. */
function CentralTab({ kind, label, active, dirty, badge, onSelect, onClose }: CentralTabProps) {
  const t = useTranslate()
  const Icon = kind === "agent" ? Bot : kind === "terminal" ? TerminalSquare : FileText
  const description =
    kind === "agent"
      ? t("Switch to this coding agent session.")
      : kind === "terminal"
        ? t("Switch to this interactive shell terminal.")
        : t("Switch to this open file in the built-in editor.")
  return (
    <div
      data-testid="central-tab"
      data-tab-kind={kind}
      data-active={active}
      data-dirty={dirty ?? false}
      className={cn(
        "flex items-center gap-1.5 border-border border-r pr-1 pl-2.5 text-xs",
        active ? "bg-background text-foreground" : "text-muted-foreground hover:bg-accent/40",
      )}
    >
      <button
        type="button"
        data-testid="central-tab-select"
        aria-label={label}
        data-feature-label={label}
        data-feature-help={description}
        onClick={onSelect}
        className="flex items-center gap-1.5 py-1.5"
        title={label}
      >
        <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden />
        <span className="max-w-40 truncate">{label}</span>
        {dirty ? (
          <span
            data-testid="central-tab-dirty"
            className="size-1.5 shrink-0 rounded-full bg-foreground/60"
          />
        ) : null}
      </button>
      {badge ? <span className="shrink-0">{badge}</span> : null}
      <button
        type="button"
        data-testid="central-tab-close"
        aria-label={`${t("Close ")}${label}`}
        data-feature-help={t(
          kind === "file"
            ? "Close this editor file tab"
            : kind === "agent"
              ? "Close this agent session tab"
              : "Close this terminal session tab",
        )}
        onClick={onClose}
        className="flex size-4 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground"
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  )
}

interface LauncherActions {
  onOpenAgent: () => void
  onOpenTerminal: () => void
  onOpenFile: () => void
  pendingAgent: boolean
  pendingTerminal: boolean
}

/** The empty-state launcher shown when nothing is open in the panel. */
function Launcher({
  onOpenAgent,
  onOpenTerminal,
  onOpenFile,
  pendingAgent,
  pendingTerminal,
}: LauncherActions) {
  const t = useTranslate()
  return (
    <div
      data-testid="central-launcher"
      className="flex min-h-0 flex-1 flex-col items-center text-muted-foreground"
    >
      {/* Spacers 1:2 place the launcher about a third of the way down the panel. */}
      <div aria-hidden className="flex-1" />
      <div data-testid="central-launcher-content" className="flex flex-col items-center gap-4">
        <p className="text-sm">{t("Open something to get started")}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <LauncherButton
            testId="launcher-agent"
            icon={<Bot className="size-4" aria-hidden />}
            label="New agent"
            description="Start a coding agent in this project workspace."
            disabled={pendingAgent}
            onClick={onOpenAgent}
          />
          <LauncherButton
            testId="launcher-terminal"
            icon={<TerminalSquare className="size-4" aria-hidden />}
            label="New terminal"
            description="Open an interactive shell in this project workspace."
            disabled={pendingTerminal}
            onClick={onOpenTerminal}
          />
          <LauncherButton
            testId="launcher-file"
            icon={<FileText className="size-4" aria-hidden />}
            label="New file"
            description="Find and open a project file in the built-in editor."
            onClick={onOpenFile}
          />
        </div>
      </div>
      <div aria-hidden className="flex-[2]" />
    </div>
  )
}

function LauncherButton({
  testId,
  icon,
  label,
  description,
  disabled,
  onClick,
}: {
  testId: string
  icon: ReactNode
  label: string
  description: string
  disabled?: boolean
  onClick: () => void
}) {
  const t = useTranslate()
  return (
    <button
      type="button"
      data-testid={testId}
      data-feature-label={t(label)}
      data-feature-help={t(description)}
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-foreground text-sm transition-colors hover:bg-accent disabled:opacity-50"
    >
      <span className="text-muted-foreground">{icon}</span>
      {t(label)}
    </button>
  )
}

function basename(relPath: string): string {
  return relPath.split("/").pop() ?? relPath
}
