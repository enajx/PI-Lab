import type { EditorSettings } from "@skipper/local-db"
import { cn } from "@skipper/ui"
import {
  Bot,
  FileText,
  PanelLeft,
  PanelLeftOpen,
  PanelRight,
  Play,
  TerminalSquare,
  X,
} from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { EdgeResizeHandle } from "../../../../../components/EdgeResizeHandle"
import { CodeMirrorBuffer } from "../../../../../Editor/components/CodeMirrorBuffer"
import { EditorSettingsMenu } from "../../../../../Editor/components/EditorSettingsMenu"
import { EditorStatusBar } from "../../../../../Editor/components/EditorStatusBar"
import { QuickOpen } from "../../../../../Editor/components/QuickOpen"
import type { EditorBuffersApi } from "../../../../../Editor/hooks/useEditorBuffers"
import { isPythonPath } from "../../../../../Editor/utils/pythonDiagnostics"
import {
  FILES_PANEL_MAX_WIDTH,
  FILES_PANEL_MIN_WIDTH,
  useFilesPanelWidth,
  useShowFilesPanel,
} from "../../../../../preferences/preferences"
import { eventMatchesShortcut } from "../../../../../shortcuts/shortcuts"
import { Terminal } from "../../../../../Terminal"
import type { SkipperTrpcClient } from "../../../../../trpc/client"
import { KindBadge } from "../KindBadge"
import { FilesPanel } from "../RightSidebar/components/FilesPanel"
import type { CentralPanelController, SessionPane } from "./useCentralPanel"

interface CentralPanelProps {
  controller: CentralPanelController
  /** App-wide tRPC client for the terminal panes' observable subscriptions. */
  client: SkipperTrpcClient
  /** Main-checkout workspace — drives quick-open search + file reads. */
  workspaceId: string
  settings: EditorSettings
  onUpdateEditorSettings: (patch: Partial<EditorSettings>) => void
  /** When the right sidebar is collapsed, the panel toolbar shows a button to
   * bring it back (the sidebar isn't mounted to host its own expand affordance). */
  rightSidebarCollapsed: boolean
  onExpandRightSidebar: () => void
}

/**
 * The project view's central panel (md/02; spec: plan "Settings panel, project-view
 * rework"). A single bounded slot that holds whatever the user opens — a running
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
  settings,
  onUpdateEditorSettings,
  rightSidebarCollapsed,
  onExpandRightSidebar,
}: CentralPanelProps) {
  const { editor, sessions, active } = controller
  const [quickOpen, setQuickOpen] = useState(false)
  const [showFilesPanel, setShowFilesPanel] = useShowFilesPanel()
  const [filesWidth, setFilesWidth] = useFilesPanelWidth()

  // Quick-open (⌘F, rebindable) opens the file palette from anywhere in the view.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (eventMatchesShortcut(event, "quick-open")) {
        event.preventDefault()
        setQuickOpen(true)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // ⌘W closes the active tab (and stays in the project). The app menu deliberately
  // leaves ⌘W unbound (see main/window/appMenu.ts) so the keystroke reaches here
  // instead of closing the window. Capture phase + a ref so it fires even over a
  // focused terminal/editor and always sees the current active tab.
  const closeActiveTabRef = useRef(controller.closeActiveTab)
  closeActiveTabRef.current = controller.closeActiveTab
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
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

  const hasFileActive = active?.type === "file" && editor.active !== null
  const showLauncher = active === null || (active.type === "file" && editor.active === null)

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
            title={showFilesPanel ? "Hide files panel" : "Show files panel"}
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

        <div
          data-testid="central-tabs"
          className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
        >
          {sessions.map((session) => (
            <CentralTab
              key={session.id}
              kind={session.kind}
              label={session.label}
              badge={
                session.kind === "agent" && session.wsKind ? (
                  <KindBadge kind={session.wsKind} />
                ) : undefined
              }
              active={active?.type === "session" && active.id === session.id}
              onSelect={() => controller.selectSession(session.id)}
              onClose={() => controller.closeSession(session.id)}
            />
          ))}
          {editor.tabs.map((tab) => (
            <CentralTab
              key={`file:${tab.relPath}`}
              kind="file"
              label={basename(tab.relPath)}
              dirty={tab.dirty}
              active={active?.type === "file" && active.relPath === tab.relPath}
              onSelect={() => controller.selectFile(tab.relPath)}
              onClose={() => controller.closeFile(tab.relPath)}
            />
          ))}
        </div>

        {/* Direct pane-creation buttons and editor settings — right. */}
        <div className="flex shrink-0 items-center gap-0.5 border-border border-l bg-muted/30 px-1">
          <button
            type="button"
            data-testid="central-new-agent"
            title="New agent"
            aria-label="New agent"
            disabled={controller.pendingAgent}
            onClick={controller.openAgent}
            className={cn(
              "flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              controller.pendingAgent && "cursor-not-allowed opacity-50",
            )}
          >
            <Play className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            data-testid="central-new-terminal"
            title="New terminal"
            aria-label="New terminal"
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
            title="New markdown"
            aria-label="New markdown"
            onClick={controller.openNewMarkdown}
            className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FileText className="size-4" aria-hidden />
          </button>
          <EditorSettingsMenu settings={settings} onChange={onUpdateEditorSettings} />
          {rightSidebarCollapsed ? (
            <button
              type="button"
              data-testid="right-sidebar-expand"
              aria-label="Expand panel"
              title="Expand panel"
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
      {editor.error ? (
        <p
          data-testid="editor-error"
          className="shrink-0 cursor-text select-text border-border border-b bg-destructive/10 px-4 py-2 text-destructive text-xs"
        >
          {editor.error}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* Optional left Files column: the workspace tree beside the editor area
            instead of in the right sidebar. Its own bounded-flex scroll region
            (AGENTS.md Pitfalls #3 — no Radix ScrollArea). */}
        {showFilesPanel ? (
          <div className="relative flex min-h-0 shrink-0" style={{ width: filesWidth }}>
            <div
              data-testid="central-files-panel"
              className="flex min-h-0 w-full flex-col overflow-y-auto border-border border-r"
            >
              <FilesPanel workspaceId={workspaceId} onOpenFile={controller.openFile} />
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
          {/* Sessions stay mounted so switching tabs never detaches a live agent. */}
          {sessions.map((session) => {
            const isActive = active?.type === "session" && active.id === session.id
            return (
              <div
                key={session.id}
                data-testid="central-session"
                data-session-kind={session.kind}
                className={cn("min-h-0 flex-1 flex-col", isActive ? "flex" : "hidden")}
              >
                <Terminal client={client} sessionId={session.sessionId} />
              </div>
            )
          })}

          {/* The editor surface stays mounted while a session is active (hidden) so
              buffer/cursor state survives a tab switch. */}
          {editor.buffers.length > 0 ? (
            <div className={cn("min-h-0 flex-1 flex-col", hasFileActive ? "flex" : "hidden")}>
              <FileSurface editor={editor} settings={settings} />
            </div>
          ) : null}

          {showLauncher ? (
            <Launcher
              onOpenAgent={controller.openAgent}
              onOpenTerminal={controller.openTerminal}
              onOpenFile={() => setQuickOpen(true)}
              pendingAgent={controller.pendingAgent}
              pendingTerminal={controller.pendingTerminal}
            />
          ) : null}
        </div>
      </div>

      {quickOpen ? (
        <QuickOpen
          workspaceId={workspaceId}
          onOpenFile={openFile}
          onClose={() => setQuickOpen(false)}
        />
      ) : null}
    </section>
  )
}

/** The editor body for the active file: banners + buffer + status bar. */
function FileSurface({ editor, settings }: { editor: EditorBuffersApi; settings: EditorSettings }) {
  const active = editor.active
  return (
    <>
      {active?.externalChange ? (
        <div
          data-testid="editor-external-warning"
          className="flex shrink-0 items-center gap-2 border-border border-b bg-amber-500/10 px-4 py-2 text-amber-600 text-xs dark:text-amber-400"
        >
          <span className="select-text">
            {active.relPath} changed on disk and you have unsaved edits. Save to overwrite, or close
            without saving to keep the on-disk version.
          </span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        {active ? (
          <CodeMirrorBuffer
            key={`${active.relPath}#${active.epoch}`}
            relPath={active.relPath}
            initialDoc={active.content}
            onChange={(doc) => editor.onEdit(active.relPath, doc)}
            onSave={() => void editor.saveFile(active.relPath)}
            vim={settings.vim}
            theme={settings.editorTheme}
            diagnostics={editor.diagnosticsSource}
          />
        ) : null}
      </div>

      <EditorStatusBar
        relPath={active?.relPath ?? null}
        isPython={active ? isPythonPath(active.relPath) : false}
        counts={editor.statusCounts}
        missing={editor.statusMissing}
        checking={editor.activeDiagnostics.checking}
        hasRun={editor.activeDiagnostics.hasRun}
      />
    </>
  )
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
  const Icon = kind === "agent" ? Bot : kind === "terminal" ? TerminalSquare : FileText
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
        aria-label={`Close ${label}`}
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
  return (
    <div
      data-testid="central-launcher"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 text-muted-foreground"
    >
      <p className="text-sm">Open something to get started</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <LauncherButton
          testId="launcher-agent"
          icon={<Play className="size-4" aria-hidden />}
          label="Open agent"
          disabled={pendingAgent}
          onClick={onOpenAgent}
        />
        <LauncherButton
          testId="launcher-terminal"
          icon={<TerminalSquare className="size-4" aria-hidden />}
          label="Open terminal"
          disabled={pendingTerminal}
          onClick={onOpenTerminal}
        />
        <LauncherButton
          testId="launcher-file"
          icon={<FileText className="size-4" aria-hidden />}
          label="Open file"
          onClick={onOpenFile}
        />
      </div>
    </div>
  )
}

function LauncherButton({
  testId,
  icon,
  label,
  disabled,
  onClick,
}: {
  testId: string
  icon: ReactNode
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-foreground text-sm transition-colors hover:bg-accent disabled:opacity-50"
    >
      <span className="text-muted-foreground">{icon}</span>
      {label}
    </button>
  )
}

function basename(relPath: string): string {
  return relPath.split("/").pop() ?? relPath
}
