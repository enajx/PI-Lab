import type { EditorSettings } from "@pi-lab/local-db/editor-settings"
import { cn } from "@pi-lab/ui"
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
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
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react"
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
import type { PiLabTrpcClient } from "../../../../../trpc/client"
import { KindBadge } from "../KindBadge"
import { FilesPanel } from "../RightSidebar/components/FilesPanel"
import type { CentralPanelController, SessionPane } from "./useCentralPanel"

interface CentralPanelProps {
  controller: CentralPanelController
  /** App-wide tRPC client for the terminal panes' observable subscriptions. */
  client: PiLabTrpcClient
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
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement | null>(null)
  const [showFilesPanel, setShowFilesPanel] = useShowFilesPanel()
  const [filesWidth, setFilesWidth] = useFilesPanelWidth()
  const runDestination = settings.pythonRunDestination ?? "central"

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
  const hasPythonActive =
    hasFileActive && editor.active !== null && isPythonPath(editor.active.relPath)
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
            aria-label={showFilesPanel ? "Hide files panel" : "Show files panel"}
            title={showFilesPanel ? "Hide files panel" : "Show files panel"}
            data-feature-help="Show the project file tree beside the editor instead of in the right sidebar"
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

        {/* Pane creation, file run, and editor settings — intentionally grouped. */}
        <div className="flex shrink-0 items-center gap-0.5 border-border border-l bg-muted/30 px-1">
          <div ref={addMenuRef} className="relative">
            <button
              type="button"
              data-testid="central-add-menu"
              title="Add pane"
              aria-label="Add pane"
              aria-expanded={addMenuOpen}
              onClick={() => setAddMenuOpen((open) => !open)}
              className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="size-4" aria-hidden />
            </button>
            {addMenuOpen ? (
              <div
                data-testid="central-add-menu-options"
                className="absolute top-8 right-0 z-30 w-36 rounded-md border border-border bg-popover p-1 shadow-lg"
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
            title="New agent"
            aria-label="New agent"
            data-feature-help="Start the remembered coding agent in this project workspace"
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
            title="New terminal"
            aria-label="New terminal"
            data-feature-help="Open an interactive shell in this project workspace"
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
            data-feature-help="Create an untitled Markdown file in the built-in editor"
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
                title="Run Python (Mod+Enter)"
                aria-label="Run Python"
                data-feature-help="Save, format, and run the focused Python file using the destination selected in Editor settings"
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
              aria-label="Expand panel"
              title="Expand panel"
              data-feature-help="Restore the project details sidebar"
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
              <FilesPanel
                workspaceId={workspaceId}
                onOpenFile={controller.openFile}
                activeRelPath={editor.active?.relPath}
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
                <Terminal client={client} inputKind={session.kind} sessionId={session.sessionId} />
              </div>
            )
          })}

          {/* The editor surface stays mounted while a session is active (hidden) so
              buffer/cursor state survives a tab switch. */}
          {editor.buffers.length > 0 ? (
            <div className={cn("min-h-0 flex-1 flex-col", hasFileActive ? "flex" : "hidden")}>
              <FileSurface
                editor={editor}
                settings={settings}
                onUpdateSettings={onUpdateEditorSettings}
                onRunPython={() => controller.runPython(runDestination)}
                belowEditorRun={controller.belowEditorRun}
                onCloseBelowEditorRun={controller.closeBelowEditorRun}
                client={client}
              />
            </div>
          ) : null}

          {showLauncher ? (
            <Launcher
              onOpenAgent={controller.openAgentChooser}
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
      {controller.agentChooserOpen ? (
        <NewAgentDialog
          key={controller.preferredAgentId}
          agents={controller.agentOptions}
          initialAgentId={controller.preferredAgentId}
          pending={controller.pendingAgent}
          error={controller.launchError}
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
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
    >
      {icon}
      {label}
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
  onStart,
  onClose,
}: {
  agents: CentralPanelController["agentOptions"]
  initialAgentId: string
  pending: boolean
  error: string | null
  onStart: (agentId: string, workspaceMode: "main" | "worktree") => void
  onClose: () => void
}) {
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
              New session
            </h2>
            <p className="mt-1 text-muted-foreground text-xs">
              Start a CLI coding agent in the project’s main checkout or its own worktree.
            </p>
          </div>
          <button type="button" aria-label="Close new session" onClick={onClose}>
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 border-border border-b p-3">
          <button type="button" className="rounded border border-primary bg-primary/10 p-2 text-xs">
            <Bot className="mx-auto mb-1 size-4" aria-hidden />
            Agent CLI
          </button>
          <button
            type="button"
            disabled
            className="rounded border border-border p-2 text-muted-foreground text-xs opacity-50"
          >
            <MessageSquare className="mx-auto mb-1 size-4" aria-hidden />
            Chat
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
                    <CheckCircle2 className="size-4 text-emerald-600" aria-label="Detected" />
                  ) : (
                    <CircleHelp
                      className="size-4 text-muted-foreground"
                      aria-label="Not detected"
                    />
                  )}
                </span>
                <span
                  className={cn(
                    "mt-1 block text-xs",
                    agent.available ? "text-emerald-600" : "text-muted-foreground",
                  )}
                >
                  {agent.available ? "Detected" : "Not detected"}
                </span>
              </span>
            </label>
          ))}
          {agents.length === 0 ? (
            <p className="text-destructive text-xs">No agent harnesses are configured.</p>
          ) : null}
          <fieldset className="col-span-2 grid grid-cols-2 gap-2 border-border border-t pt-3">
            <legend className="mb-2 text-muted-foreground text-xs">Run agent in</legend>
            <label
              className={cn(
                "cursor-pointer rounded-md border p-2 text-sm",
                workspaceMode === "main" ? "border-primary bg-primary/5" : "border-border",
              )}
            >
              <input
                type="radio"
                name="agent-workspace"
                aria-label="Main"
                value="main"
                checked={workspaceMode === "main"}
                onChange={() => setWorkspaceMode("main")}
                className="sr-only"
              />
              Main
              <span className="mt-0.5 block text-muted-foreground text-xs">Project checkout</span>
            </label>
            <label
              className={cn(
                "cursor-pointer rounded-md border p-2 text-sm",
                workspaceMode === "worktree" ? "border-primary bg-primary/5" : "border-border",
              )}
            >
              <input
                type="radio"
                name="agent-workspace"
                aria-label="Worktree"
                value="worktree"
                checked={workspaceMode === "worktree"}
                onChange={() => setWorkspaceMode("worktree")}
                className="sr-only"
              />
              Worktree
              <span className="mt-0.5 block text-muted-foreground text-xs">Isolated checkout</span>
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
            Cancel
          </button>
          <button
            type="button"
            disabled={!selectedAvailable || pending}
            onClick={() => onStart(selected, workspaceMode)}
            className="rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm disabled:opacity-50"
          >
            Start agent
          </button>
        </div>
      </div>
    </div>
  )
}

/** The editor body for the active file: banners + buffer + status bar. */
function FileSurface({
  editor,
  settings,
  onUpdateSettings,
  onRunPython,
  belowEditorRun,
  onCloseBelowEditorRun,
  client,
}: {
  editor: EditorBuffersApi
  settings: EditorSettings
  onUpdateSettings: (patch: Partial<EditorSettings>) => void
  onRunPython: () => void
  belowEditorRun: CentralPanelController["belowEditorRun"]
  onCloseBelowEditorRun: () => void
  client: PiLabTrpcClient
}) {
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
            onRun={isPythonPath(active.relPath) ? onRunPython : undefined}
            vim={settings.vim}
            theme={settings.editorTheme}
            customThemes={settings.customEditorThemes ?? []}
            diagnostics={editor.diagnosticsSource}
          />
        ) : null}
      </div>

      {belowEditorRun ? (
        <BelowEditorTerminal run={belowEditorRun} client={client} onClose={onCloseBelowEditorRun} />
      ) : null}

      <EditorStatusBar
        isPython={active ? isPythonPath(active.relPath) : false}
        counts={editor.statusCounts}
        missing={editor.statusMissing}
        checking={editor.activeDiagnostics.checking}
        hasRun={editor.activeDiagnostics.hasRun}
        diagnosticsEnabled={settings.diagnosticsEnabled}
        onToggleDiagnostics={() =>
          onUpdateSettings({ diagnosticsEnabled: !settings.diagnosticsEnabled })
        }
        pythonRuntime={editor.pythonRuntime}
        listPythonEnvironments={editor.listPythonEnvironments}
        selectPythonEnvironment={editor.selectPythonEnvironment}
        choosePythonEnvironment={editor.choosePythonEnvironment}
      />
    </>
  )
}

function BelowEditorTerminal({
  run,
  client,
  onClose,
}: {
  run: NonNullable<CentralPanelController["belowEditorRun"]>
  client: PiLabTrpcClient
  onClose: () => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [height, setHeight] = useState(220)

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startY = event.clientY
    const startHeight = height
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const onMove = (move: PointerEvent) => {
      setHeight(Math.min(480, Math.max(120, startHeight - (move.clientY - startY))))
    }
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", cleanup)
      window.removeEventListener("pointercancel", cleanup)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", cleanup)
    window.addEventListener("pointercancel", cleanup)
  }

  return (
    <section
      data-testid="editor-run-terminal"
      className="relative flex shrink-0 flex-col border-border border-t bg-background"
      style={collapsed ? undefined : { height }}
    >
      <div
        data-testid="editor-run-terminal-resize"
        aria-hidden
        onPointerDown={onResizeStart}
        className="-top-1.5 absolute inset-x-0 z-20 h-1.5 cursor-row-resize hover:bg-primary/30"
      />
      <div className="flex h-7 shrink-0 items-center gap-2 border-border border-b bg-muted/30 px-2">
        <button
          type="button"
          data-testid="editor-run-terminal-collapse"
          aria-label={collapsed ? "Reopen run terminal" : "Collapse run terminal"}
          onClick={() => setCollapsed((value) => !value)}
          className="text-muted-foreground hover:text-foreground"
        >
          {collapsed ? (
            <ChevronRight className="size-3.5" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden />
          )}
        </button>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{run.label}</span>
        <button
          type="button"
          data-testid="editor-run-terminal-close"
          aria-label="Close run terminal"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      {collapsed ? null : (
        <div className="min-h-0 flex-1">
          <Terminal
            key={run.sessionId}
            client={client}
            inputKind="terminal"
            sessionId={run.sessionId}
          />
        </div>
      )}
    </section>
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
  const description =
    kind === "agent"
      ? "Switch to this coding agent session."
      : kind === "terminal"
        ? "Switch to this interactive shell terminal."
        : "Switch to this open file in the built-in editor."
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
        aria-label={`Close ${label}`}
        data-feature-help={`Close this ${kind === "file" ? "editor file" : `${kind} session`} tab`}
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
  return (
    <button
      type="button"
      data-testid={testId}
      data-feature-label={label}
      data-feature-help={description}
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
