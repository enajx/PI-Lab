import type { EditorSettings } from "@pi-lab/local-db/editor-settings"
import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useEffect, useState } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../test/fakeTrpcClient"
import { FilesPanel } from "../RightSidebar/components/FilesPanel"

/**
 * Integration test for the project view's central panel (plan "Settings panel,
 * project-view rework") — the real shipping editor surface. Covers the panel
 * itself (launcher, opening files/terminals as top-level tabs, closing) AND the
 * editor behaviour the buffer machinery owns (dirty/save, external-change
 * reconcile, one-shot Python diagnostics, the settings menu, autosave,
 * format-on-save). The real CodeMirror view + xterm need layout APIs jsdom lacks,
 * so both are stubbed; the stub re-exposes the buffer's `onChange`/`onSave`/`vim`/
 * `diagnostics` props so we assert through the public DOM + a faked tRPC client.
 */

let lastBufferProps: {
  vim?: boolean
  diagnostics?: ((doc: string) => unknown) | undefined
  onRun?: (() => void) | undefined
  markdownMode?: "render" | "source"
  projectEntries?: Array<{ name: string; relPath: string; kind: "file" | "dir" }>
} = {}

vi.mock("../../../../../Terminal", () => ({
  Terminal: ({ inputKind, sessionId }: { inputKind: "agent" | "terminal"; sessionId?: string }) => (
    <div data-testid="terminal" data-input-kind={inputKind} data-session-id={sessionId} />
  ),
}))

vi.mock("../../../../../Editor/components/CodeMirrorBuffer", () => ({
  CodeMirrorBuffer: ({
    relPath,
    initialDoc,
    onChange,
    onSave,
    onRun,
    vim,
    diagnostics,
    markdownMode,
    projectEntries,
  }: {
    relPath: string
    initialDoc: string
    onChange: (doc: string) => void
    onSave: () => void
    onRun?: () => void
    vim?: boolean
    diagnostics?: (doc: string) => unknown
    markdownMode?: "render" | "source"
    projectEntries?: Array<{ name: string; relPath: string; kind: "file" | "dir" }>
  }) => {
    lastBufferProps = { vim, diagnostics, onRun, markdownMode, projectEntries }
    // Mirror CodeMirror: seed from initialDoc once on mount (live reloads remount
    // via a new React key), so the displayed doc only changes on a real remount.
    const [seeded] = useState(initialDoc)
    return (
      <div data-testid="editor-buffer">
        <pre data-testid="buffer-doc">{seeded}</pre>
        <span data-testid="buffer-path">{relPath}</span>
        <span data-testid="buffer-vim">{String(vim)}</span>
        <span data-testid="buffer-has-diagnostics">{String(Boolean(diagnostics))}</span>
        <span data-testid="buffer-markdown-mode">{markdownMode ?? "none"}</span>
        <span data-testid="buffer-project-entries">
          {projectEntries?.map((entry) => entry.relPath).join(",") ?? ""}
        </span>
        <button type="button" data-testid="buffer-type" onClick={() => onChange(`${seeded} EDIT`)}>
          type
        </button>
        <button type="button" data-testid="buffer-save" onClick={() => onSave()}>
          save
        </button>
        {onRun ? (
          <button type="button" data-testid="buffer-run" onClick={() => onRun()}>
            run
          </button>
        ) : null}
      </div>
    )
  },
}))

const { CentralPanel } = await import("./CentralPanel")
const { useCentralPanel } = await import("./useCentralPanel")
type CentralPanelRestoreState = import("./useCentralPanel").CentralPanelRestoreState

const DEFAULT_SETTINGS: EditorSettings = {
  autosave: false,
  vim: false,
  diagnosticsEnabled: false,
  typeChecker: "ty",
  formatOnSave: false,
  editorTheme: "default",
  customEditorThemes: [],
  pythonRunDestination: "central",
  latexProvider: "bundled",
}

const PY_DIAGNOSTIC = {
  source: "ruff" as const,
  severity: "warning" as const,
  line: 1,
  column: 1,
  message: "`os` imported but unused",
  code: "F401",
}

const ENV_RUNTIME = {
  source: "dot-venv" as const,
  displayName: "repo-x/.venv (3.13)",
  interpreterPath: "/workspace/.venv/bin/python",
  runStrategy: {
    kind: "environment" as const,
    command: "/workspace/.venv/bin/python",
    argsPrefix: [],
  },
}

const NO_ENV_RUNTIME = {
  source: null,
  displayName: "No virtual env",
  interpreterPath: "/usr/bin/python3",
  runStrategy: {
    kind: "python3" as const,
    command: "/usr/bin/python3",
    argsPrefix: [],
  },
}

let written: Array<{ relPath: string; content: string }>
let diskContent: string
let diskStat: { exists: boolean; mtimeMs: number; size: number }
let checkCalls: Array<{ relPath: string; typeChecker: string; lint: boolean }>
let checkResult: {
  diagnostics: (typeof PY_DIAGNOSTIC)[]
  toolsAvailable: boolean
  missing: string[]
}
let rememberedAgentId: string | null
let launchedAgents: string[]
let launchedWorkspaceModes: string[]

beforeEach(() => {
  window.history.replaceState({}, "", "/")
  window.localStorage.clear()
  lastBufferProps = {}
  written = []
  diskContent = "print('hi')\n"
  diskStat = { exists: true, mtimeMs: 1000, size: diskContent.length }
  checkCalls = []
  checkResult = { diagnostics: [PY_DIAGNOSTIC], toolsAvailable: true, missing: [] }
  rememberedAgentId = null
  launchedAgents = []
  launchedWorkspaceModes = []
})

afterEach(() => {
  vi.clearAllTimers()
})

function baseHandlers(treeName = "main.py", overrides: FakeHandlers = {}): FakeHandlers {
  return {
    "files.tree": () => [{ name: treeName, relPath: treeName, kind: "file" as const }],
    "files.read": () => ({
      status: diskStat.exists ? "text" : "missing",
      exists: diskStat.exists,
      content: diskContent,
      baseline: diskStat,
    }),
    "files.stat": () => diskStat,
    "files.write": (input) => {
      const { relPath, content } = input as { relPath: string; content: string }
      written.push({ relPath, content })
      diskContent = content
      diskStat = { exists: true, mtimeMs: diskStat.mtimeMs + 10, size: content.length }
      return { bytes: content.length, baseline: diskStat, matchesWrittenContent: true }
    },
    "files.search": () => ({ hits: [], partial: false, skipped: [] }),
    "diagnostics.check": (input) => {
      const { relPath, typeChecker, lint } = input as {
        relPath: string
        typeChecker: string
        lint: boolean
      }
      checkCalls.push({ relPath, typeChecker, lint })
      return checkResult
    },
    "diagnostics.format": () => ({ toolsAvailable: true, changed: false, missing: [] }),
    "workspaces.spawnTerminal": () => ({ sessionId: "term-1" }),
    "terminal.list": () => [],
    "settings.get": () => ({ agents: { defaultAgentId: "claude-code" } }),
    "agents.list": () => [
      {
        id: "claude-code",
        label: "Claude Code",
        available: true,
        executable: "/usr/bin/claude",
      },
      { id: "codex", label: "Codex", available: false, executable: "codex" },
    ],
    "agents.projectChoice": () => ({ agentId: rememberedAgentId, storage: "app" }),
    "agents.setProjectChoice": (input) => {
      rememberedAgentId = (input as { agentId: string }).agentId
      return { agentId: rememberedAgentId, storage: "app" }
    },
    "sessions.start": (input) => {
      const launch = input as { agentId: string; workspaceMode: string }
      launchedAgents.push(launch.agentId)
      launchedWorkspaceModes.push(launch.workspaceMode)
      return { sessionId: `agent-${launchedAgents.length}`, workspaceId: "ws-1", kind: "branch" }
    },
    "python.resolve": () => ENV_RUNTIME,
    "python.resolveLocal": () => null,
    "python.options": () => [
      {
        path: "/workspace/.venv",
        displayName: ENV_RUNTIME.displayName,
        interpreterPath: ENV_RUNTIME.interpreterPath,
      },
    ],
    "python.select": () => ENV_RUNTIME,
    "python.runFile": () => ({ sessionId: "python-term-1", runtime: ENV_RUNTIME }),
    "terminal.kill": () => ({ ok: true }),
    "system.pickDirectory": () => null,
    "system.pickFile": () => null,
    ...overrides,
  }
}

function Harness({
  client,
  settings,
  onUpdate,
  initialSession,
  activatedSession,
  initialState,
  onPinFile,
}: {
  client: ReturnType<typeof createFakeTrpcClient>
  settings: EditorSettings
  onUpdate: (patch: Partial<EditorSettings>) => void
  initialSession?: {
    kind: "agent"
    sessionId: string
    label: string
    wsKind: "branch" | "worktree"
  }
  activatedSession?: {
    kind: "agent"
    sessionId: string
    label: string
    wsKind: "branch" | "worktree"
  }
  initialState?: CentralPanelRestoreState
  onPinFile?: (relPath: string) => void
}) {
  const controller = useCentralPanel({
    client,
    workspaceId: "ws-1",
    projectId: "p-1",
    settings,
    initialSession,
    initialState,
  })
  useEffect(() => {
    if (activatedSession) controller.attachSession(activatedSession)
  }, [activatedSession, controller.attachSession])
  return (
    <div>
      <FilesPanel
        workspaceId="ws-1"
        onOpenFile={controller.openFile}
        activeRelPath={controller.editor.active?.relPath}
      />
      <CentralPanel
        controller={controller}
        client={client}
        workspaceId="ws-1"
        openFileFinder={false}
        onFileFinderOpened={() => {}}
        settings={settings}
        onUpdateEditorSettings={onUpdate}
        rightSidebarCollapsed={false}
        onExpandRightSidebar={() => {}}
        onPinFile={onPinFile}
      />
    </div>
  )
}

function renderPanel(
  handlers: FakeHandlers = baseHandlers(),
  settings: EditorSettings = DEFAULT_SETTINGS,
  onUpdate: (patch: Partial<EditorSettings>) => void = () => {},
  initialSession?: {
    kind: "agent"
    sessionId: string
    label: string
    wsKind: "branch" | "worktree"
  },
  activatedSession?: {
    kind: "agent"
    sessionId: string
    label: string
    wsKind: "branch" | "worktree"
  },
  onPinFile?: (relPath: string) => void,
  initialState?: CentralPanelRestoreState,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  return render(
    <AppProviders client={client} queryClient={queryClient}>
      <Harness
        client={client}
        settings={settings}
        onUpdate={onUpdate}
        initialSession={initialSession}
        activatedSession={activatedSession}
        initialState={initialState}
        onPinFile={onPinFile}
      />
    </AppProviders>,
  )
}

function renderStatefulPanel(handlers: FakeHandlers, initialSettings: EditorSettings) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)

  function StatefulHarness() {
    const [settings, setSettings] = useState(initialSettings)
    return (
      <Harness
        client={client}
        settings={settings}
        onUpdate={(patch) => setSettings((current) => ({ ...current, ...patch }))}
      />
    )
  }

  render(
    <AppProviders client={client} queryClient={queryClient}>
      <StatefulHarness />
    </AppProviders>,
  )
}

async function openFile() {
  fireEvent.click(await screen.findByTestId("file-tree-file"))
  await screen.findByTestId("editor-buffer")
}

describe("CentralPanel — panel", () => {
  test("translates launcher controls without changing file data", async () => {
    window.localStorage.setItem("pi-lab.interface.language", "es")
    renderPanel()

    expect(await screen.findByText("Abre algo para empezar")).toBeTruthy()
    expect(screen.getByTestId("central-add-menu").getAttribute("aria-label")).toBe("Añadir panel")
  })

  test("robot uses the Settings default when no project agent is set", async () => {
    renderPanel()
    await waitFor(() =>
      expect(screen.getByTestId("central-new-agent").hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByTestId("central-new-agent"))
    await screen.findByTestId("terminal")
    expect(rememberedAgentId).toBeNull()
    expect(launchedAgents).toEqual(["claude-code"])
    expect(launchedWorkspaceModes).toEqual(["policy"])
  })

  test("an unavailable configured agent opens the chooser", async () => {
    rememberedAgentId = "codex"
    renderPanel()
    await waitFor(() =>
      expect(screen.getByTestId("central-new-agent").hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByTestId("central-new-agent"))
    expect(await screen.findByTestId("new-agent-dialog")).toBeTruthy()
    fireEvent.click(screen.getByLabelText("Claude Code"))
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }))
    await screen.findByTestId("terminal")
    expect(rememberedAgentId).toBe("codex")
  })

  test("robot direct-launches the remembered harness while plus Agent reopens the chooser", async () => {
    rememberedAgentId = "claude-code"
    renderPanel(
      baseHandlers("main.py", {
        "agents.list": () => [
          {
            id: "claude-code",
            label: "Claude Code",
            available: true,
            executable: "/usr/bin/claude",
          },
          { id: "codex", label: "Codex", available: true, executable: "/usr/bin/codex" },
        ],
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId("central-new-agent").hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByTestId("central-new-agent"))
    await screen.findByTestId("terminal")
    expect(launchedAgents).toEqual(["claude-code"])

    fireEvent.click(screen.getByTestId("central-add-menu"))
    fireEvent.click(screen.getByTestId("central-add-agent"))
    expect(await screen.findByTestId("new-agent-dialog")).toBeTruthy()
    fireEvent.click(screen.getByLabelText("Codex"))
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }))
    await waitFor(() => expect(launchedAgents).toHaveLength(2))
    expect(rememberedAgentId).toBe("claude-code")
    expect(launchedAgents).toEqual(["claude-code", "codex"])

    fireEvent.click(screen.getByTestId("central-new-agent"))
    await waitFor(() => expect(launchedAgents).toEqual(["claude-code", "codex", "claude-code"]))
  })

  test("New session shows Agent CLI, disabled Chat, and lets a launch choose Main or Worktree", async () => {
    renderPanel()
    await waitFor(() =>
      expect(screen.getByTestId("launcher-agent").hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByTestId("central-add-menu"))
    fireEvent.click(screen.getByTestId("central-add-agent"))
    const dialog = await screen.findByTestId("new-agent-dialog")
    expect(within(dialog).getByRole("button", { name: "Chat" }).hasAttribute("disabled")).toBe(true)
    expect(within(dialog).queryByRole("button", { name: "Terminal" })).toBeNull()
    expect(within(dialog).getByLabelText("Main")).toBeTruthy()

    fireEvent.click(within(dialog).getByLabelText("Worktree"))
    fireEvent.click(within(dialog).getByLabelText("Claude Code"))
    fireEvent.click(within(dialog).getByRole("button", { name: "Start agent" }))
    await waitFor(() => expect(launchedWorkspaceModes).toEqual(["worktree"]))
  })

  test("the plus menu creates Terminal and Document panes while preserving direct controls", async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId("central-add-menu"))
    fireEvent.click(screen.getByTestId("central-add-terminal"))
    expect((await screen.findByTestId("terminal")).getAttribute("data-input-kind")).toBe("terminal")

    fireEvent.click(screen.getByTestId("central-add-menu"))
    fireEvent.click(screen.getByTestId("central-add-document"))
    expect((await screen.findByTestId("buffer-path")).textContent).toBe("untitled.md")
    expect(screen.getByTestId("central-new-terminal")).toBeTruthy()
    expect(screen.getByTestId("central-new-markdown")).toBeTruthy()
    expect(screen.getByTestId("central-settings-divider")).toBeTruthy()
  })

  test("dismisses the add menu on Escape or an outside click, and dismisses New session outside", async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId("central-add-menu"))
    expect(screen.getByTestId("central-add-menu-options")).toBeTruthy()
    expect(screen.getByText("Agent CLI")).toBeTruthy()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByTestId("central-add-menu-options")).toBeNull()

    fireEvent.click(screen.getByTestId("central-add-menu"))
    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId("central-add-menu-options")).toBeNull()

    fireEvent.click(screen.getByTestId("central-add-menu"))
    fireEvent.click(screen.getByTestId("central-add-agent"))
    const dialog = await screen.findByTestId("new-agent-dialog")
    fireEvent.mouseDown(dialog)
    expect(screen.queryByTestId("new-agent-dialog")).toBeNull()

    fireEvent.click(screen.getByTestId("central-add-menu"))
    fireEvent.click(screen.getByTestId("central-add-agent"))
    await screen.findByTestId("new-agent-dialog")
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByTestId("new-agent-dialog")).toBeNull()
  })

  test("surfaces an agent spawn failure in the central panel", async () => {
    renderPanel(
      baseHandlers("main.py", {
        "sessions.start": () => {
          throw new Error("Claude Code could not be spawned")
        },
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId("launcher-agent").hasAttribute("disabled")).toBe(false),
    )
    fireEvent.click(screen.getByTestId("launcher-agent"))
    fireEvent.click(await screen.findByLabelText("Claude Code"))
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }))

    expect((await screen.findByTestId("central-error")).textContent).toContain(
      "Claude Code could not be spawned",
    )
  })

  test("orders the standalone add menu immediately before the direct robot control", async () => {
    renderPanel()
    const add = screen.getByTestId("central-add-menu")
    const robot = screen.getByTestId("central-new-agent")
    expect(add.compareDocumentPosition(robot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(add.parentElement?.nextElementSibling).toBe(robot)
    expect(robot.getAttribute("aria-label")).toBe("New agent")
  })

  test("shows the launcher when nothing is open", () => {
    renderPanel()
    expect(screen.getByTestId("central-launcher")).toBeTruthy()
    expect(screen.getByTestId("launcher-agent").textContent).toContain("New agent")
    expect(screen.getByTestId("launcher-terminal").textContent).toContain("New terminal")
    expect(screen.getByTestId("launcher-file").textContent).toContain("New file")
    expect(screen.getByTestId("launcher-agent").getAttribute("data-feature-help")).toBe(
      "Start a coding agent in this project workspace.",
    )
    expect(screen.getByTestId("launcher-terminal").getAttribute("data-feature-help")).toBe(
      "Open an interactive shell in this project workspace.",
    )
    expect(screen.getByTestId("launcher-file").getAttribute("data-feature-help")).toBe(
      "Find and open a project file in the built-in editor.",
    )
  })

  test("opening a file from the tree adds a file tab and shows the buffer", async () => {
    renderPanel()
    expect((await screen.findByTestId("file-tree-file")).getAttribute("data-feature-label")).toBe(
      "File",
    )
    await openFile()

    const tab = screen.getByTestId("central-tab")
    expect(tab.getAttribute("data-tab-kind")).toBe("file")
    expect(
      within(tab).getByRole("button", { name: "main.py" }).getAttribute("data-feature-help"),
    ).toBe("Switch to this open file in the built-in editor.")
    expect(screen.getByTestId("buffer-doc").textContent).toBe("print('hi')\n")
    expect(screen.getByTestId("file-tree-focused").getAttribute("aria-label")).toBe(
      "Focused in editor",
    )
    expect(screen.queryByTestId("central-launcher")).toBeNull()
    // Freshly opened ⇒ not dirty.
    expect(screen.queryByTestId("central-tab-dirty")).toBeNull()
  })

  test("the launcher opens a plain terminal as a session tab", async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId("launcher-terminal"))

    const terminal = await screen.findByTestId("terminal")
    expect(terminal.getAttribute("data-session-id")).toBe("term-1")
    expect(terminal.getAttribute("data-input-kind")).toBe("terminal")
    expect(screen.getByTestId("central-tab").getAttribute("data-tab-kind")).toBe("terminal")
    expect(
      within(screen.getByTestId("central-tab"))
        .getByTestId("central-tab-select")
        .getAttribute("data-feature-help"),
    ).toBe("Switch to this interactive shell terminal.")
  })

  test("closing a terminal tab terminates its PTY instead of leaving a hidden session", async () => {
    const killed: string[] = []
    renderPanel(
      baseHandlers("main.py", {
        "terminal.kill": (input) => {
          killed.push((input as { sessionId: string }).sessionId)
          return { ok: true }
        },
      }),
    )
    fireEvent.click(screen.getByTestId("launcher-terminal"))
    await screen.findByTestId("terminal")

    fireEvent.click(screen.getByTestId("central-tab-close"))

    await waitFor(() => expect(killed).toEqual(["term-1"]))
    expect(screen.getByTestId("central-launcher")).toBeTruthy()
    expect(screen.queryByTestId("terminal")).toBeNull()
  })

  test("restoration reattaches live sessions and recreates missing sessions from launch config", async () => {
    const spawned: unknown[] = []
    const launched: unknown[] = []
    const initialState: CentralPanelRestoreState = {
      buffers: [],
      activeRelPath: null,
      sessions: [
        {
          id: "pane-1",
          kind: "terminal",
          sessionId: "live-terminal",
          label: "Terminal",
          launch: { type: "terminal" },
        },
        {
          id: "pane-2",
          kind: "agent",
          sessionId: "dead-agent",
          label: "Claude Code",
          wsKind: "worktree",
          launch: { type: "agent", agentId: "claude-code", workspaceMode: "worktree" },
        },
      ],
      active: { type: "session", id: "pane-2" },
      belowEditorRun: null,
    }
    renderPanel(
      baseHandlers("main.py", {
        "terminal.list": () => [
          { id: "live-terminal", pid: 1, cols: 80, rows: 24, alive: true, createdAt: 1 },
        ],
        "workspaces.spawnTerminal": (input) => {
          spawned.push(input)
          return { sessionId: "unexpected-terminal" }
        },
        "sessions.start": (input) => {
          launched.push(input)
          return { sessionId: "recreated-agent", workspaceId: "ws-new", kind: "worktree" }
        },
      }),
      DEFAULT_SETTINGS,
      () => {},
      undefined,
      undefined,
      undefined,
      initialState,
    )

    await waitFor(() => {
      const ids = screen
        .getAllByTestId("terminal")
        .map((terminal) => terminal.getAttribute("data-session-id"))
      expect(ids).toEqual(["live-terminal", "recreated-agent"])
    })
    expect(spawned).toEqual([])
    expect(launched).toEqual([
      { projectId: "p-1", agentId: "claude-code", workspaceMode: "worktree" },
    ])
    const activeTab = screen
      .getAllByTestId("central-tab")
      .find((tab) => tab.getAttribute("data-active") === "true")
    expect(activeTab?.textContent).toContain("Claude Code")
  })

  test("leaving during restoration kills any newly recreated session instead of orphaning it", async () => {
    let resolveList!: (sessions: unknown[]) => void
    const listed = new Promise<unknown[]>((resolve) => {
      resolveList = resolve
    })
    const killed: string[] = []
    const initialState: CentralPanelRestoreState = {
      buffers: [],
      activeRelPath: null,
      sessions: [
        {
          id: "pane-1",
          kind: "terminal",
          sessionId: "dead-terminal",
          label: "Terminal",
          launch: { type: "terminal" },
        },
      ],
      active: { type: "session", id: "pane-1" },
      belowEditorRun: null,
    }
    const rendered = renderPanel(
      baseHandlers("main.py", {
        "terminal.list": () => listed,
        "workspaces.spawnTerminal": () => ({ sessionId: "unclaimed-terminal" }),
        "terminal.kill": (input) => {
          killed.push((input as { sessionId: string }).sessionId)
          return { ok: true }
        },
      }),
      DEFAULT_SETTINGS,
      () => {},
      undefined,
      undefined,
      undefined,
      initialState,
    )

    rendered.unmount()
    resolveList([])

    await waitFor(() => expect(killed).toContain("unclaimed-terminal"))
  })

  test("a task-launched agent is attached and focused on first render", async () => {
    renderPanel(baseHandlers(), DEFAULT_SETTINGS, () => {}, {
      kind: "agent",
      sessionId: "task-agent-1",
      label: "Implement parser",
      wsKind: "worktree",
    })

    const terminal = await screen.findByTestId("terminal")
    expect(terminal.getAttribute("data-session-id")).toBe("task-agent-1")
    expect(terminal.getAttribute("data-input-kind")).toBe("agent")
    const tab = screen.getByTestId("central-tab")
    expect(tab.getAttribute("data-tab-kind")).toBe("agent")
    expect(tab.textContent).toContain("Implement parser")
    expect(screen.queryByTestId("central-launcher")).toBeNull()
  })

  test("an activated live agent attaches once and an existing tab is selected exactly", async () => {
    const activation = {
      kind: "agent" as const,
      sessionId: "notified-agent-1",
      label: "Codex",
      wsKind: "branch" as const,
    }
    const { rerender } = (() => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const client = createFakeTrpcClient(baseHandlers())
      const renderHarness = (activatedSession: typeof activation) => (
        <AppProviders client={client} queryClient={queryClient}>
          <Harness
            client={client}
            settings={DEFAULT_SETTINGS}
            onUpdate={() => {}}
            activatedSession={activatedSession}
          />
        </AppProviders>
      )
      const result = render(renderHarness(activation))
      return {
        rerender: (next: typeof activation) => result.rerender(renderHarness(next)),
      }
    })()

    expect((await screen.findByTestId("terminal")).getAttribute("data-session-id")).toBe(
      "notified-agent-1",
    )
    await openFile()
    expect(screen.getByTestId("editor-buffer")).toBeTruthy()
    rerender({ ...activation })
    await waitFor(() => expect(screen.getAllByTestId("terminal")).toHaveLength(1))
    expect(screen.getAllByTestId("central-tab")).toHaveLength(2)
    expect(
      screen
        .getAllByTestId("central-tab")
        .find((tab) => tab.getAttribute("data-tab-kind") === "agent")
        ?.getAttribute("data-active"),
    ).toBe("true")
  })

  test("closing the only tab returns to the launcher", async () => {
    renderPanel()
    await openFile()
    fireEvent.click(screen.getByTestId("central-tab-close"))
    await waitFor(() => expect(screen.getByTestId("central-launcher")).toBeTruthy())
  })

  test("Ctrl+W closes the active tab and stays in the project (returns to the launcher)", async () => {
    renderPanel()
    await openFile()
    expect(screen.getByTestId("central-tab")).toBeTruthy()
    fireEvent.keyDown(window, { key: "w", metaKey: true })
    expect(screen.getByTestId("central-tab")).toBeTruthy()
    fireEvent.keyDown(window, { key: "w", ctrlKey: true })
    await waitFor(() => expect(screen.getByTestId("central-launcher")).toBeTruthy())
  })

  test("a failed file-open surfaces an error banner (no silent failure)", async () => {
    renderPanel(
      baseHandlers("main.py", {
        "files.read": async () => {
          throw new Error("read failed")
        },
      }),
    )
    fireEvent.click(await screen.findByTestId("file-tree-file"))

    // The open failed, so the body stays on the launcher — but the error is shown
    // at the panel level rather than swallowed.
    await waitFor(() => expect(screen.getByTestId("editor-error")).toBeTruthy())
    expect(screen.getByTestId("editor-error").textContent).toContain("main.py")
    expect(screen.getByTestId("central-launcher")).toBeTruthy()
  })
})

describe("CentralPanel — left Files panel", () => {
  test("the files toggle reveals a left Files column and flips its pressed state", () => {
    renderPanel()
    const toggle = screen.getByTestId("central-files-toggle")
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
    expect(screen.queryByTestId("central-files-panel")).toBeNull()

    fireEvent.click(toggle)

    expect(toggle.getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByTestId("central-files-panel")).toBeTruthy()
    expect(window.localStorage.getItem("pi-lab.projectView.showFilesPanel")).toBe("true")
  })

  test("opening a file from the left tree opens it in the central editor", async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId("central-files-toggle"))

    const panel = screen.getByTestId("central-files-panel")
    fireEvent.click(await within(panel).findByTestId("file-tree-file"))

    await screen.findByTestId("editor-buffer")
    const tab = screen.getByTestId("central-tab")
    expect(tab.getAttribute("data-tab-kind")).toBe("file")
    expect(screen.getByTestId("buffer-path").textContent).toBe("main.py")
  })

  test("the left tree's right-click 'Pin as panel' works when onPinFile is threaded through", async () => {
    const pinned: string[] = []
    renderPanel(
      baseHandlers("notes.md"),
      DEFAULT_SETTINGS,
      () => {},
      undefined,
      undefined,
      (relPath) => pinned.push(relPath),
    )
    fireEvent.click(screen.getByTestId("central-files-toggle"))

    const panel = screen.getByTestId("central-files-panel")
    // Right-click the Markdown file row in the LEFT (central) tree to open its menu.
    fireEvent.contextMenu(await within(panel).findByTestId("file-tree-file"))
    fireEvent.click(await screen.findByTestId("file-tree-pin"))

    expect(pinned).toEqual(["notes.md"])
  })
})

describe("CentralPanel — editor behaviour", () => {
  test("Markdown opens in Render and toggles to raw Source", async () => {
    renderPanel(baseHandlers("notes.md"))
    const note = (await screen.findAllByTestId("file-tree-file")).find(
      (file) => file.getAttribute("data-rel-path") === "notes.md",
    )
    fireEvent.click(note as HTMLElement)
    await screen.findByTestId("editor-buffer")

    expect(
      screen.getByRole("button", { name: "Render Markdown" }).getAttribute("aria-pressed"),
    ).toBe("true")
    expect(screen.getByTestId("buffer-markdown-mode").textContent).toBe("render")
    expect(screen.getByTestId("buffer-project-entries").textContent).toBe("")

    fireEvent.click(screen.getByRole("button", { name: "Source Markdown" }))
    expect(screen.getByTestId("buffer-markdown-mode").textContent).toBe("source")
    expect(
      screen.getByRole("button", { name: "Source Markdown" }).getAttribute("aria-pressed"),
    ).toBe("true")
  })

  test("editing marks the tab dirty; ⌘S writes it and clears the dirty state", async () => {
    renderPanel()
    await openFile()

    fireEvent.click(screen.getByTestId("buffer-type"))
    await waitFor(() => expect(screen.getByTestId("central-tab-dirty")).toBeTruthy())

    fireEvent.click(screen.getByTestId("buffer-save"))
    await waitFor(() => expect(written).toHaveLength(1))
    expect(written[0]).toEqual({ relPath: "main.py", content: "print('hi')\n EDIT" })
    await waitFor(() => expect(screen.queryByTestId("central-tab-dirty")).toBeNull())
  })

  test("an external change to a CLEAN buffer reloads without disabled diagnostics", async () => {
    vi.useFakeTimers()
    try {
      renderPanel()
      await vi.waitFor(() => expect(screen.queryByTestId("file-tree-file")).toBeTruthy())
      fireEvent.click(screen.getByTestId("file-tree-file"))
      await vi.waitFor(() => expect(screen.queryByTestId("editor-buffer")).toBeTruthy())
      expect(screen.getByTestId("buffer-doc").textContent).toBe("print('hi')\n")

      // Agent/git rewrites the file on disk.
      diskContent = "print('reloaded')\n"
      diskStat = { exists: true, mtimeMs: 5000, size: diskContent.length }
      await vi.advanceTimersByTimeAsync(2_000)

      await vi.waitFor(() =>
        expect(screen.getByTestId("buffer-doc").textContent).toBe("print('reloaded')\n"),
      )
      expect(screen.queryByTestId("editor-external-warning")).toBeNull()
      expect(screen.queryByTestId("central-tab-dirty")).toBeNull()
      expect(checkCalls).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  test("an external change to a DIRTY buffer warns instead of clobbering", async () => {
    vi.useFakeTimers()
    try {
      renderPanel()
      await vi.waitFor(() => expect(screen.queryByTestId("file-tree-file")).toBeTruthy())
      fireEvent.click(screen.getByTestId("file-tree-file"))
      await vi.waitFor(() => expect(screen.queryByTestId("editor-buffer")).toBeTruthy())

      fireEvent.click(screen.getByTestId("buffer-type"))
      await vi.waitFor(() => expect(screen.queryByTestId("central-tab-dirty")).toBeTruthy())

      diskContent = "print('from agent')\n"
      diskStat = { exists: true, mtimeMs: 9000, size: diskContent.length }
      await vi.advanceTimersByTimeAsync(2_000)

      await vi.waitFor(() => expect(screen.queryByTestId("editor-external-warning")).toBeTruthy())
      // The user's edit is preserved (no clobber) and stays dirty.
      expect(screen.getByTestId("buffer-doc").textContent).toBe("print('hi')\n")
      expect(screen.getByTestId("central-tab-dirty")).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  test("Python diagnostics default off and the lower-right status enables them accessibly", async () => {
    const onUpdate = vi.fn()
    renderPanel(baseHandlers("main.py"), DEFAULT_SETTINGS, onUpdate)
    await openFile()

    expect(checkCalls).toHaveLength(0)
    expect(lastBufferProps.diagnostics).toBeUndefined()
    const toggle = screen.getByTestId("editor-diagnostics-toggle")
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
    expect(toggle.getAttribute("aria-label")).toBe("Turn Python type checking on")
    expect(toggle.textContent).toBe("Type check: Off")

    fireEvent.click(toggle)
    expect(onUpdate).toHaveBeenCalledWith({ diagnosticsEnabled: true })
  })

  test("an enabled Python file surfaces diagnostics in the status bar and the buffer", async () => {
    renderPanel(baseHandlers("main.py"), { ...DEFAULT_SETTINGS, diagnosticsEnabled: true })
    await openFile()

    await waitFor(() => expect(checkCalls.length).toBeGreaterThan(0))
    expect(checkCalls[0]).toEqual({ relPath: "main.py", typeChecker: "ty", lint: true })
    await waitFor(() => expect(screen.getByTestId("editor-diagnostics-warnings")).toBeTruthy())
    expect(screen.getByTestId("editor-diagnostics-warnings").textContent).toContain("1")
    await waitFor(() => expect(lastBufferProps.diagnostics).toBeTypeOf("function"))
  })

  test("enabling diagnostics checks the Python file that is already open", async () => {
    renderStatefulPanel(baseHandlers("main.py"), DEFAULT_SETTINGS)
    await openFile()
    expect(checkCalls).toHaveLength(0)

    fireEvent.click(screen.getByTestId("editor-diagnostics-toggle"))

    await waitFor(() => expect(checkCalls).toHaveLength(1))
    expect(screen.getByTestId("editor-diagnostics-toggle").getAttribute("aria-pressed")).toBe(
      "true",
    )
    await waitFor(() => expect(lastBufferProps.diagnostics).toBeTypeOf("function"))
  })

  test("turning diagnostics off clears stale results and gates later save checks", async () => {
    renderStatefulPanel(baseHandlers("main.py"), {
      ...DEFAULT_SETTINGS,
      diagnosticsEnabled: true,
    })
    await openFile()
    await waitFor(() => expect(checkCalls).toHaveLength(1))
    await waitFor(() => expect(lastBufferProps.diagnostics).toBeTypeOf("function"))

    fireEvent.click(screen.getByTestId("editor-diagnostics-toggle"))

    await waitFor(() =>
      expect(screen.getByTestId("editor-diagnostics-toggle").getAttribute("aria-pressed")).toBe(
        "false",
      ),
    )
    await waitFor(() => expect(lastBufferProps.diagnostics).toBeUndefined())
    expect(screen.queryByTestId("editor-diagnostics-warnings")).toBeNull()

    fireEvent.click(screen.getByTestId("buffer-type"))
    fireEvent.click(screen.getByTestId("buffer-save"))
    await waitFor(() => expect(written).toHaveLength(1))
    expect(checkCalls).toHaveLength(1)
  })

  test("a diagnostics response finishing after disablement is ignored", async () => {
    let finishCheck: ((value: typeof checkResult) => void) | undefined
    const pendingCheck = new Promise<typeof checkResult>((resolve) => {
      finishCheck = resolve
    })
    renderStatefulPanel(
      baseHandlers("main.py", {
        "diagnostics.check": (input) => {
          const { relPath, typeChecker, lint } = input as {
            relPath: string
            typeChecker: string
            lint: boolean
          }
          checkCalls.push({ relPath, typeChecker, lint })
          return pendingCheck
        },
      }),
      { ...DEFAULT_SETTINGS, diagnosticsEnabled: true },
    )
    await openFile()
    await waitFor(() => expect(checkCalls).toHaveLength(1))

    fireEvent.click(screen.getByTestId("editor-diagnostics-toggle"))
    await waitFor(() =>
      expect(screen.getByTestId("editor-diagnostics-toggle").getAttribute("aria-pressed")).toBe(
        "false",
      ),
    )
    finishCheck?.(checkResult)

    await waitFor(() => expect(lastBufferProps.diagnostics).toBeUndefined())
    expect(screen.queryByTestId("editor-diagnostics-warnings")).toBeNull()
  })

  test("an old pre-disable response cannot overwrite a newer post-enable response", async () => {
    const pendingChecks: Array<(value: typeof checkResult) => void> = []
    renderStatefulPanel(
      baseHandlers("main.py", {
        "diagnostics.check": (input) => {
          const { relPath, typeChecker, lint } = input as {
            relPath: string
            typeChecker: string
            lint: boolean
          }
          checkCalls.push({ relPath, typeChecker, lint })
          return new Promise<typeof checkResult>((resolve) => pendingChecks.push(resolve))
        },
      }),
      { ...DEFAULT_SETTINGS, diagnosticsEnabled: true },
    )
    await openFile()
    await waitFor(() => expect(pendingChecks).toHaveLength(1))

    fireEvent.click(screen.getByTestId("editor-diagnostics-toggle"))
    await waitFor(() =>
      expect(screen.getByTestId("editor-diagnostics-toggle").getAttribute("aria-pressed")).toBe(
        "false",
      ),
    )
    fireEvent.click(screen.getByTestId("editor-diagnostics-toggle"))
    await waitFor(() => expect(pendingChecks).toHaveLength(2))

    const oldResult = {
      ...checkResult,
      diagnostics: [{ ...PY_DIAGNOSTIC, message: "old pre-disable result" }],
    }
    const newResult = {
      ...checkResult,
      diagnostics: [{ ...PY_DIAGNOSTIC, message: "new post-enable result" }],
    }
    await act(async () => {
      pendingChecks[1]?.(newResult)
      await Promise.resolve()
    })
    await waitFor(() => {
      const diagnostics = lastBufferProps.diagnostics?.(diskContent) as
        | Array<{ message: string }>
        | undefined
      expect(diagnostics?.[0]?.message).toBe("new post-enable result")
    })

    await act(async () => {
      pendingChecks[0]?.(oldResult)
      await Promise.resolve()
    })
    const diagnostics = lastBufferProps.diagnostics?.(diskContent) as
      | Array<{ message: string }>
      | undefined
    expect(diagnostics?.[0]?.message).toBe("new post-enable result")
  })

  test("the Python footer shows the detected environment and interpreter tooltip", async () => {
    renderPanel(baseHandlers("main.py"))
    await openFile()

    const runtime = await screen.findByTestId("editor-python-runtime")
    await waitFor(() => expect(runtime.textContent).toContain("repo-x/.venv (3.13)"))
    expect(runtime.getAttribute("title")).toBe("/workspace/.venv/bin/python")
  })

  test("the Python footer explicitly shows when no virtual environment is active", async () => {
    renderPanel(
      baseHandlers("main.py", {
        "python.resolve": () => NO_ENV_RUNTIME,
      }),
    )
    await openFile()

    const runtime = await screen.findByTestId("editor-python-runtime")
    await waitFor(() => expect(runtime.textContent).toBe("No virtual env"))
    expect(runtime.getAttribute("title")).toBe("/usr/bin/python3")
  })

  test("the detected environment is clickable and can switch to a suggested environment", async () => {
    const selectedRuntime = {
      ...ENV_RUNTIME,
      source: "selected" as const,
      displayName: "repo-x/venv (3.12)",
      interpreterPath: "/workspace/venv/bin/python",
      runStrategy: {
        ...ENV_RUNTIME.runStrategy,
        command: "/workspace/venv/bin/python",
      },
    }
    let selectedPath: string | null | undefined
    renderPanel(
      baseHandlers("main.py", {
        "python.options": () => [
          {
            path: "/workspace/venv",
            displayName: selectedRuntime.displayName,
            interpreterPath: selectedRuntime.interpreterPath,
          },
        ],
        "python.select": (input) => {
          selectedPath = (input as { path: string | null }).path
          return selectedRuntime
        },
      }),
    )
    await openFile()

    fireEvent.click(await screen.findByTestId("editor-python-runtime"))
    const optionLabel = await screen.findByText("repo-x/venv (3.12)")
    fireEvent.click(optionLabel.closest("button") as HTMLButtonElement)

    await waitFor(() => expect(selectedPath).toBe("/workspace/venv"))
    await waitFor(() =>
      expect(screen.getByTestId("editor-python-runtime").textContent).toContain(
        "repo-x/venv (3.12)",
      ),
    )
  })

  test("the environment menu keeps project choices before clearly labelled manager globals", async () => {
    renderPanel(
      baseHandlers("main.py", {
        "python.options": () => [
          {
            path: "/workspace/.venv",
            displayName: "repo-x/.venv (3.13)",
            interpreterPath: "/workspace/.venv/bin/python",
          },
          {
            path: "/global/conda/envs/research",
            displayName: "Conda · research (3.12)",
            interpreterPath: "/global/conda/envs/research/bin/python",
          },
        ],
      }),
    )
    await openFile()

    fireEvent.click(await screen.findByTestId("editor-python-runtime"))
    const menu = await screen.findByRole("menu", { name: "Python environment" })
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
      (item) => item.textContent,
    )

    expect(items[0]).toContain("repo-x/.venv (3.13)")
    expect(items[1]).toContain("Conda · research (3.12)")
    expect(items).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Choose environment folder…"),
        expect.stringContaining("Choose Python interpreter…"),
      ]),
    )
  })

  test("the missing-environment state can manually choose an interpreter", async () => {
    const manualRuntime = {
      ...ENV_RUNTIME,
      source: "selected" as const,
      displayName: "research",
      interpreterPath: "/shared/conda/research/bin/python",
      runStrategy: {
        ...ENV_RUNTIME.runStrategy,
        command: "/shared/conda/research/bin/python",
      },
    }
    let selectedPath: string | null | undefined
    renderPanel(
      baseHandlers("main.py", {
        "python.resolve": () => NO_ENV_RUNTIME,
        "python.options": () => [],
        "system.pickFile": () => "/shared/conda/research/bin/python",
        "python.select": (input) => {
          selectedPath = (input as { path: string | null }).path
          return manualRuntime
        },
      }),
    )
    await openFile()

    fireEvent.click(await screen.findByTestId("editor-python-runtime"))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Choose Python interpreter…" }))

    await waitFor(() => expect(selectedPath).toBe("/shared/conda/research/bin/python"))
    await waitFor(() =>
      expect(screen.getByTestId("editor-python-runtime").textContent).toContain("research"),
    )
  })

  test("a failed manual selection stays open with a visible error", async () => {
    renderPanel(
      baseHandlers("main.py", {
        "python.resolve": () => NO_ENV_RUNTIME,
        "python.options": () => [],
        "system.pickFile": () => "/broken/bin/python",
        "python.select": () => {
          throw new Error("not a working Python interpreter")
        },
      }),
    )
    await openFile()

    fireEvent.click(await screen.findByTestId("editor-python-runtime"))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Choose Python interpreter…" }))

    const error = await screen.findByTestId("python-environment-selection-error")
    expect(error.textContent).toContain("not a working Python interpreter")
    expect(screen.getByRole("menu", { name: "Python environment" })).toBeTruthy()
  })

  test("a newly created local environment is noticed while the Python file stays active", async () => {
    vi.useFakeTimers()
    let fullResolveCalls = 0
    let localResolveCalls = 0
    try {
      renderPanel(
        baseHandlers("main.py", {
          "python.resolve": () => {
            fullResolveCalls++
            return NO_ENV_RUNTIME
          },
          "python.resolveLocal": () => {
            localResolveCalls++
            return ENV_RUNTIME
          },
        }),
      )
      await vi.waitFor(() => expect(screen.queryByTestId("file-tree-file")).toBeTruthy())
      fireEvent.click(screen.getByTestId("file-tree-file"))
      await vi.waitFor(() =>
        expect(screen.queryByTestId("editor-python-runtime")?.textContent).toContain(
          "No virtual env",
        ),
      )

      await vi.advanceTimersByTimeAsync(3_100)

      await vi.waitFor(
        () =>
          expect(screen.getByTestId("editor-python-runtime").textContent).toContain(
            "repo-x/.venv (3.13)",
          ),
        { timeout: 3_000 },
      )
      expect(fullResolveCalls).toBe(1)
      expect(localResolveCalls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test("returning to Python editing after a non-Python file rechecks the environment", async () => {
    let resolveCalls = 0
    renderPanel(
      baseHandlers("main.py", {
        "files.tree": () => [
          { name: "main.py", relPath: "main.py", kind: "file" as const },
          { name: "notes.txt", relPath: "notes.txt", kind: "file" as const },
        ],
        "python.resolve": () => {
          resolveCalls++
          return resolveCalls === 1
            ? ENV_RUNTIME
            : {
                ...ENV_RUNTIME,
                displayName: "refreshed-env",
                interpreterPath: "/workspace/refreshed-env/bin/python",
                runStrategy: {
                  ...ENV_RUNTIME.runStrategy,
                  command: "/workspace/refreshed-env/bin/python",
                },
              }
        },
      }),
    )

    const files = await screen.findAllByTestId("file-tree-file")
    const pythonFile = files.find((file) => file.getAttribute("data-rel-path") === "main.py")
    const textFile = files.find((file) => file.getAttribute("data-rel-path") === "notes.txt")
    expect(pythonFile).toBeTruthy()
    expect(textFile).toBeTruthy()

    fireEvent.click(pythonFile as HTMLElement)
    await waitFor(() => expect(resolveCalls).toBe(1))
    fireEvent.click(textFile as HTMLElement)
    await waitFor(() => expect(screen.getByTestId("buffer-path").textContent).toBe("notes.txt"))
    expect(screen.queryByTestId("editor-python-runtime")).toBeNull()

    const pythonTab = screen
      .getAllByTestId("central-tab")
      .find((tab) => within(tab).queryByRole("button", { name: "main.py" }))
    fireEvent.click(within(pythonTab as HTMLElement).getByRole("button", { name: "main.py" }))

    await waitFor(() => expect(resolveCalls).toBe(2))
    await waitFor(() =>
      expect(screen.getByTestId("editor-python-runtime").textContent).toBe("refreshed-env"),
    )
  })

  test("a non-Python file gets no diagnostics check and no diagnostics source", async () => {
    renderPanel(baseHandlers("notes.txt"))
    await openFile()

    await waitFor(() => expect(screen.getByTestId("buffer-path").textContent).toBe("notes.txt"))
    expect(checkCalls).toHaveLength(0)
    expect(screen.queryByTestId("editor-diagnostics-warnings")).toBeNull()
    expect(lastBufferProps.diagnostics).toBeUndefined()
  })

  test("Run Python is visible only for the focused Python editor", async () => {
    renderPanel(baseHandlers("notes.txt"))
    await openFile()
    expect(screen.queryByTestId("central-run-python")).toBeNull()
    expect(screen.queryByTestId("buffer-run")).toBeNull()
  })

  test("the focused Python editor exposes Run Python and its Mod+Enter callback", async () => {
    renderPanel(baseHandlers("main.py"))
    await openFile()

    expect(screen.getByTestId("central-run-python")).toBeTruthy()
    expect(screen.getByTestId("buffer-run")).toBeTruthy()
    expect(lastBufferProps.onRun).toBeTypeOf("function")
  })

  test("Run Python saves, formats, then launches and selects a new terminal tab", async () => {
    const calls: string[] = []
    renderPanel(
      baseHandlers("main.py", {
        "files.write": (input) => {
          calls.push("save")
          const { relPath, content } = input as { relPath: string; content: string }
          written.push({ relPath, content })
          return { bytes: content.length, baseline: diskStat, matchesWrittenContent: true }
        },
        "diagnostics.format": () => {
          calls.push("format")
          return { toolsAvailable: true, changed: false, missing: [] }
        },
        "python.runFile": (input) => {
          calls.push("run")
          expect(input).toEqual({
            workspaceId: "ws-1",
            relPath: "main.py",
            cols: 80,
            rows: 24,
          })
          return { sessionId: "python-run-terminal", runtime: ENV_RUNTIME }
        },
      }),
      { ...DEFAULT_SETTINGS, formatOnSave: true },
    )
    await openFile()

    // The fake editor's run control invokes the public onRun prop used by the
    // focused CodeMirror buffer's Mod+Enter keymap.
    fireEvent.click(screen.getByTestId("buffer-run"))

    await waitFor(() => expect(calls).toEqual(["save", "format", "run"]))
    const terminal = await screen.findByTestId("terminal")
    expect(terminal.getAttribute("data-session-id")).toBe("python-run-terminal")
    const runTab = screen
      .getAllByTestId("central-tab")
      .find((tab) => tab.getAttribute("data-tab-kind") === "terminal")
    expect(runTab).toBeTruthy()
    expect(runTab?.getAttribute("data-active")).toBe("true")
    expect(runTab?.textContent).toContain("Run main.py")
  })

  test("the below-editor default runs in one persistent resizable region without a central tab", async () => {
    renderPanel(baseHandlers("main.py"), {
      ...DEFAULT_SETTINGS,
      pythonRunDestination: "below-editor",
    })
    await openFile()
    fireEvent.click(screen.getByTestId("buffer-run"))

    const region = await screen.findByTestId("editor-run-terminal")
    expect(within(region).getByTestId("terminal").getAttribute("data-session-id")).toBe(
      "python-term-1",
    )
    expect(screen.queryByTestId("central-session")).toBeNull()
    expect(
      screen
        .getAllByTestId("central-tab")
        .some((tab) => tab.getAttribute("data-tab-kind") === "terminal"),
    ).toBe(false)
    const resize = screen.getByTestId("editor-run-terminal-resize")
    Object.defineProperty(resize, "setPointerCapture", { value: vi.fn() })
    const down = new Event("pointerdown", { bubbles: true })
    Object.defineProperties(down, {
      button: { value: 0 },
      pointerId: { value: 1 },
      clientY: { value: 300 },
    })
    fireEvent(resize, down)
    const move = new Event("pointermove")
    Object.defineProperty(move, "clientY", { value: 250 })
    fireEvent(window, move)
    await waitFor(() => expect(region.getAttribute("style")).toContain("height: 270px"))
    fireEvent(window, new Event("pointerup"))
  })

  test("the below-editor region survives switching between file tabs", async () => {
    renderPanel(
      baseHandlers("main.py", {
        "files.tree": () => [
          { name: "main.py", relPath: "main.py", kind: "file" as const },
          { name: "other.py", relPath: "other.py", kind: "file" as const },
        ],
      }),
      { ...DEFAULT_SETTINGS, pythonRunDestination: "below-editor" },
    )
    fireEvent.click(
      (await screen.findAllByTestId("file-tree-file")).find(
        (entry) => entry.getAttribute("data-rel-path") === "main.py",
      ) as HTMLElement,
    )
    await waitFor(() => expect(screen.getByTestId("buffer-path").textContent).toBe("main.py"))
    fireEvent.click(screen.getByTestId("buffer-run"))
    await screen.findByTestId("editor-run-terminal")

    fireEvent.click(
      screen
        .getAllByTestId("file-tree-file")
        .find((entry) => entry.getAttribute("data-rel-path") === "other.py") as HTMLElement,
    )
    await waitFor(() => expect(screen.getByTestId("buffer-path").textContent).toBe("other.py"))
    expect(screen.getByTestId("editor-run-terminal")).toBeTruthy()
    expect(screen.getByTestId("terminal").getAttribute("data-session-id")).toBe("python-term-1")
  })

  test("subsequent below-editor runs replace the region session and it can collapse, reopen, and close", async () => {
    let run = 0
    const killed: string[] = []
    renderPanel(
      baseHandlers("main.py", {
        "python.runFile": () => ({
          sessionId: `python-below-${++run}`,
          runtime: ENV_RUNTIME,
        }),
        "terminal.kill": (input) => {
          killed.push((input as { sessionId: string }).sessionId)
          return { ok: true }
        },
      }),
      { ...DEFAULT_SETTINGS, pythonRunDestination: "below-editor" },
    )
    await openFile()

    fireEvent.click(screen.getByTestId("buffer-run"))
    await waitFor(() =>
      expect(screen.getByTestId("terminal").getAttribute("data-session-id")).toBe("python-below-1"),
    )
    fireEvent.click(screen.getByTestId("buffer-run"))
    await waitFor(() =>
      expect(screen.getByTestId("terminal").getAttribute("data-session-id")).toBe("python-below-2"),
    )
    expect(screen.getAllByTestId("editor-run-terminal")).toHaveLength(1)
    expect(killed).toContain("python-below-1")

    fireEvent.click(screen.getByTestId("editor-run-terminal-collapse"))
    expect(screen.queryByTestId("terminal")).toBeNull()
    fireEvent.click(screen.getByTestId("editor-run-terminal-collapse"))
    expect(screen.getByTestId("terminal")).toBeTruthy()
    fireEvent.click(screen.getByTestId("editor-run-terminal-close"))
    await waitFor(() => expect(screen.queryByTestId("editor-run-terminal")).toBeNull())
    expect(killed).toContain("python-below-2")
  })

  test("a failed save aborts Run Python and surfaces the save error", async () => {
    let runCalls = 0
    renderPanel(
      baseHandlers("main.py", {
        "files.write": async () => {
          throw new Error("disk is read-only")
        },
        "python.runFile": () => {
          runCalls++
          return { sessionId: "must-not-launch", runtime: ENV_RUNTIME }
        },
      }),
    )
    await openFile()

    fireEvent.click(screen.getByTestId("central-run-python"))

    await waitFor(() => expect(screen.getByTestId("editor-error")).toBeTruthy())
    expect(screen.getByTestId("editor-error").textContent).toContain("disk is read-only")
    expect(runCalls).toBe(0)
    expect(screen.queryByTestId("terminal")).toBeNull()
  })

  test("the graceful tooling-missing path shows an install hint, not errors", async () => {
    checkResult = { diagnostics: [], toolsAvailable: false, missing: ["ty", "ruff"] }
    renderPanel(baseHandlers("main.py"), { ...DEFAULT_SETTINGS, diagnosticsEnabled: true })
    await openFile()

    await waitFor(() => expect(screen.getByTestId("editor-tools-missing")).toBeTruthy())
    expect(screen.queryByTestId("editor-diagnostics-errors")).toBeNull()
    expect(screen.getByTestId("editor-tools-missing").textContent).toContain("install uv")
  })

  test("a re-check fires after a successful save, and the type-checker setting flows through", async () => {
    renderPanel(baseHandlers("main.py"), {
      ...DEFAULT_SETTINGS,
      diagnosticsEnabled: true,
      typeChecker: "pyrefly",
    })
    await openFile()
    await waitFor(() => expect(checkCalls).toHaveLength(1))
    expect(checkCalls[0]?.typeChecker).toBe("pyrefly")

    fireEvent.click(screen.getByTestId("buffer-type"))
    fireEvent.click(screen.getByTestId("buffer-save"))
    await waitFor(() => expect(checkCalls).toHaveLength(2))
  })

  test("vim reflects the setting and passes through to the buffer", async () => {
    renderPanel(baseHandlers("main.py"), { ...DEFAULT_SETTINGS, vim: true })
    await openFile()
    expect(screen.getByTestId("buffer-vim").textContent).toBe("true")
    expect(lastBufferProps.vim).toBe(true)
  })

  test("the settings menu round-trips a patch through onUpdate", async () => {
    const onUpdate = vi.fn()
    renderPanel(baseHandlers(), DEFAULT_SETTINGS, onUpdate)

    fireEvent.click(screen.getByTestId("editor-settings"))
    fireEvent.click(screen.getByTestId("editor-settings-autosave"))
    expect(onUpdate).toHaveBeenCalledWith({ autosave: true })
  })

  test("autosave persists a dirty buffer after the debounce without ⌘S", async () => {
    vi.useFakeTimers()
    try {
      renderPanel(baseHandlers("main.py"), { ...DEFAULT_SETTINGS, autosave: true })
      await vi.waitFor(() => expect(screen.queryByTestId("file-tree-file")).toBeTruthy())
      fireEvent.click(screen.getByTestId("file-tree-file"))
      await vi.waitFor(() => expect(screen.queryByTestId("editor-buffer")).toBeTruthy())

      fireEvent.click(screen.getByTestId("buffer-type"))
      await vi.waitFor(() => expect(screen.queryByTestId("central-tab-dirty")).toBeTruthy())

      await vi.advanceTimersByTimeAsync(1_000)
      await vi.waitFor(() => expect(diskContent).toContain("EDIT"))
      await vi.waitFor(() => expect(screen.queryByTestId("central-tab-dirty")).toBeNull())
    } finally {
      vi.useRealTimers()
    }
  })

  test("format-on-save runs ruff format and reloads the buffer when it changed", async () => {
    let formatCalls = 0
    renderPanel(
      baseHandlers("main.py", {
        "diagnostics.format": () => {
          formatCalls++
          diskContent = "import os  # formatted\n"
          diskStat = { exists: true, mtimeMs: diskStat.mtimeMs + 5, size: diskContent.length }
          return { toolsAvailable: true, changed: true, missing: [] }
        },
      }),
      { ...DEFAULT_SETTINGS, formatOnSave: true },
    )
    await openFile()

    fireEvent.click(screen.getByTestId("buffer-type"))
    fireEvent.click(screen.getByTestId("buffer-save"))

    await waitFor(() => expect(formatCalls).toBe(1))
    await waitFor(() => expect(screen.getByTestId("buffer-doc").textContent).toContain("formatted"))
  })
})

test("Python Run is blocked by an external conflict and shows explicit resolution actions", async () => {
  const run = vi.fn(() => ({ sessionId: "run", runtime: ENV_RUNTIME }))
  renderPanel(baseHandlers("main.py", { "python.runFile": run }))
  await openFile()
  fireEvent.click(screen.getByTestId("buffer-type"))
  diskContent = "external"
  diskStat = { exists: true, mtimeMs: 9999, size: 8 }
  fireEvent.click(screen.getByTestId("buffer-run"))
  await waitFor(() => expect(screen.getByTestId("editor-external-warning")).toBeTruthy())
  expect(run).not.toHaveBeenCalled()
  expect(written).toHaveLength(0)
  expect(screen.getByRole("button", { name: "Overwrite disk" })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Reload from disk" }))
  await waitFor(() => expect(screen.getByTestId("buffer-doc").textContent).toBe("external"))
  expect(screen.queryByTestId("editor-external-warning")).toBeNull()
})

test.each([
  "failed",
  "stale",
] as const)("Python Run is blocked after a %s save (mocked IPC)", async (outcome) => {
  let release!: () => void
  const boundary = new Promise<void>((resolve) => {
    release = resolve
  })
  const write = vi.fn(async () => {
    await boundary
    if (outcome === "failed") throw new Error("write failed")
    return { bytes: 12, baseline: diskStat, matchesWrittenContent: true }
  })
  const run = vi.fn(() => ({ sessionId: "run", runtime: ENV_RUNTIME }))
  renderPanel(baseHandlers("main.py", { "files.write": write, "python.runFile": run }))
  await openFile()
  fireEvent.click(screen.getByTestId("buffer-run"))
  await waitFor(() => expect(write).toHaveBeenCalled())
  if (outcome === "stale") fireEvent.click(screen.getByTestId("buffer-type"))
  await act(async () => {
    release()
    await boundary
  })
  if (outcome === "failed")
    await waitFor(() => expect(screen.getByText(/Could not save main.py/)).toBeTruthy())
  else expect(screen.getByTestId("central-tab-dirty")).toBeTruthy()
  expect(run).not.toHaveBeenCalled()
})
