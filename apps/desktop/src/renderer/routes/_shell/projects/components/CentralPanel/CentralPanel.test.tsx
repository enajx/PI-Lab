import type { EditorSettings } from "@skipper/local-db"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useState } from "react"
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

let lastBufferProps: { vim?: boolean; diagnostics?: ((doc: string) => unknown) | undefined } = {}

vi.mock("../../../../../Terminal", () => ({
  Terminal: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid="terminal" data-session-id={sessionId} />
  ),
}))

vi.mock("../../../../../Editor/components/CodeMirrorBuffer", () => ({
  CodeMirrorBuffer: ({
    relPath,
    initialDoc,
    onChange,
    onSave,
    vim,
    diagnostics,
  }: {
    relPath: string
    initialDoc: string
    onChange: (doc: string) => void
    onSave: () => void
    vim?: boolean
    diagnostics?: (doc: string) => unknown
  }) => {
    lastBufferProps = { vim, diagnostics }
    // Mirror CodeMirror: seed from initialDoc once on mount (live reloads remount
    // via a new React key), so the displayed doc only changes on a real remount.
    const [seeded] = useState(initialDoc)
    return (
      <div data-testid="editor-buffer">
        <pre data-testid="buffer-doc">{seeded}</pre>
        <span data-testid="buffer-path">{relPath}</span>
        <span data-testid="buffer-vim">{String(vim)}</span>
        <span data-testid="buffer-has-diagnostics">{String(Boolean(diagnostics))}</span>
        <button type="button" data-testid="buffer-type" onClick={() => onChange(`${seeded} EDIT`)}>
          type
        </button>
        <button type="button" data-testid="buffer-save" onClick={() => onSave()}>
          save
        </button>
      </div>
    )
  },
}))

const { CentralPanel } = await import("./CentralPanel")
const { useCentralPanel } = await import("./useCentralPanel")

const DEFAULT_SETTINGS: EditorSettings = {
  autosave: false,
  vim: false,
  typeChecker: "ty",
  formatOnSave: false,
  editorTheme: "default",
}

const PY_DIAGNOSTIC = {
  source: "ruff" as const,
  severity: "warning" as const,
  line: 1,
  column: 1,
  message: "`os` imported but unused",
  code: "F401",
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

beforeEach(() => {
  window.localStorage.clear()
  lastBufferProps = {}
  written = []
  diskContent = "print('hi')\n"
  diskStat = { exists: true, mtimeMs: 1000, size: diskContent.length }
  checkCalls = []
  checkResult = { diagnostics: [PY_DIAGNOSTIC], toolsAvailable: true, missing: [] }
})

afterEach(() => {
  vi.clearAllTimers()
})

function baseHandlers(treeName = "main.py", overrides: FakeHandlers = {}): FakeHandlers {
  return {
    "files.tree": () => [{ name: treeName, relPath: treeName, kind: "file" as const }],
    "files.read": () => ({ exists: diskStat.exists, content: diskContent }),
    "files.stat": () => diskStat,
    "files.write": (input) => {
      const { relPath, content } = input as { relPath: string; content: string }
      written.push({ relPath, content })
      diskContent = content
      diskStat = { exists: true, mtimeMs: diskStat.mtimeMs + 10, size: content.length }
      return { bytes: content.length }
    },
    "files.search": () => [],
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
    ...overrides,
  }
}

function Harness({
  client,
  settings,
  onUpdate,
}: {
  client: ReturnType<typeof createFakeTrpcClient>
  settings: EditorSettings
  onUpdate: (patch: Partial<EditorSettings>) => void
}) {
  const controller = useCentralPanel({
    client,
    workspaceId: "ws-1",
    projectId: "p-1",
    settings,
  })
  return (
    <div>
      <FilesPanel workspaceId="ws-1" onOpenFile={controller.openFile} />
      <CentralPanel
        controller={controller}
        client={client}
        workspaceId="ws-1"
        settings={settings}
        onUpdateEditorSettings={onUpdate}
        rightSidebarCollapsed={false}
        onExpandRightSidebar={() => {}}
      />
    </div>
  )
}

function renderPanel(
  handlers: FakeHandlers = baseHandlers(),
  settings: EditorSettings = DEFAULT_SETTINGS,
  onUpdate: (patch: Partial<EditorSettings>) => void = () => {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <Harness client={client} settings={settings} onUpdate={onUpdate} />
    </AppProviders>,
  )
}

async function openFile() {
  fireEvent.click(await screen.findByTestId("file-tree-file"))
  await screen.findByTestId("editor-buffer")
}

describe("CentralPanel — panel", () => {
  test("shows the launcher when nothing is open", () => {
    renderPanel()
    expect(screen.getByTestId("central-launcher")).toBeTruthy()
  })

  test("opening a file from the tree adds a file tab and shows the buffer", async () => {
    renderPanel()
    await openFile()

    const tab = screen.getByTestId("central-tab")
    expect(tab.getAttribute("data-tab-kind")).toBe("file")
    expect(screen.getByTestId("buffer-doc").textContent).toBe("print('hi')\n")
    expect(screen.queryByTestId("central-launcher")).toBeNull()
    // Freshly opened ⇒ not dirty.
    expect(screen.queryByTestId("central-tab-dirty")).toBeNull()
  })

  test("the launcher opens a plain terminal as a session tab", async () => {
    renderPanel()
    fireEvent.click(screen.getByTestId("launcher-terminal"))

    const terminal = await screen.findByTestId("terminal")
    expect(terminal.getAttribute("data-session-id")).toBe("term-1")
    expect(screen.getByTestId("central-tab").getAttribute("data-tab-kind")).toBe("terminal")
  })

  test("closing the only tab returns to the launcher", async () => {
    renderPanel()
    await openFile()
    fireEvent.click(screen.getByTestId("central-tab-close"))
    await waitFor(() => expect(screen.getByTestId("central-launcher")).toBeTruthy())
  })

  test("⌘W closes the active tab and stays in the project (returns to the launcher)", async () => {
    renderPanel()
    await openFile()
    expect(screen.getByTestId("central-tab")).toBeTruthy()
    fireEvent.keyDown(window, { key: "w", metaKey: true })
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
    expect(window.localStorage.getItem("skipper.projectView.showFilesPanel")).toBe("true")
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
})

describe("CentralPanel — editor behaviour", () => {
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

  test("an external change to a CLEAN buffer auto-reloads the content", async () => {
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

  test("a Python file surfaces diagnostics in the status bar and the buffer", async () => {
    renderPanel(baseHandlers("main.py"))
    await openFile()

    await waitFor(() => expect(checkCalls.length).toBeGreaterThan(0))
    expect(checkCalls[0]).toEqual({ relPath: "main.py", typeChecker: "ty", lint: true })
    await waitFor(() => expect(screen.getByTestId("editor-diagnostics-warnings")).toBeTruthy())
    expect(screen.getByTestId("editor-diagnostics-warnings").textContent).toContain("1")
    await waitFor(() => expect(lastBufferProps.diagnostics).toBeTypeOf("function"))
  })

  test("a non-Python file gets no diagnostics check and no diagnostics source", async () => {
    renderPanel(baseHandlers("notes.txt"))
    await openFile()

    await waitFor(() => expect(screen.getByTestId("buffer-path").textContent).toBe("notes.txt"))
    expect(checkCalls).toHaveLength(0)
    expect(screen.queryByTestId("editor-diagnostics-warnings")).toBeNull()
    expect(lastBufferProps.diagnostics).toBeUndefined()
  })

  test("the graceful tooling-missing path shows an install hint, not errors", async () => {
    checkResult = { diagnostics: [], toolsAvailable: false, missing: ["ty", "ruff"] }
    renderPanel(baseHandlers("main.py"))
    await openFile()

    await waitFor(() => expect(screen.getByTestId("editor-tools-missing")).toBeTruthy())
    expect(screen.queryByTestId("editor-diagnostics-errors")).toBeNull()
    expect(screen.getByTestId("editor-tools-missing").textContent).toContain("install uv")
  })

  test("a re-check fires after a successful save, and the type-checker setting flows through", async () => {
    renderPanel(baseHandlers("main.py"), { ...DEFAULT_SETTINGS, typeChecker: "pyrefly" })
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
