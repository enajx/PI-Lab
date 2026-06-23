import type { EditorSettings } from "@skipper/local-db"
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createFakeTrpcClient, type FakeHandlers } from "../../../test/fakeTrpcClient"

/**
 * Integration tests for the editor's diagnostics + settings wiring (spec: TODO
 * "Built-in editor"). The real CodeMirror view needs layout APIs jsdom lacks, so
 * we stub {@link CodeMirrorBuffer} with a tiny harness that re-exposes its
 * `vim`/`diagnostics` props — letting us assert that the active-Python-file
 * diagnostics source and the vim setting flow through, while the status bar
 * (which is real) carries the surfaced counts / tooling-missing hint.
 */

let lastBufferProps: {
  vim?: boolean
  diagnostics?: ((doc: string) => unknown) | undefined
} = {}

vi.mock("../CodeMirrorBuffer", () => ({
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

const { EditorPane } = await import("./EditorPane")
const { AppProviders } = await import("../../../providers/AppProviders")

const PY_DIAGNOSTIC = {
  source: "ruff" as const,
  severity: "warning" as const,
  line: 1,
  column: 1,
  message: "`os` imported but unused",
  code: "F401",
}

let diskContent: string
let diskStat: { exists: boolean; mtimeMs: number; size: number }
let checkCalls: Array<{ relPath: string; typeChecker: string; lint: boolean }>
let checkResult: {
  diagnostics: (typeof PY_DIAGNOSTIC)[]
  toolsAvailable: boolean
  missing: string[]
}

beforeEach(() => {
  lastBufferProps = {}
  diskContent = "import os\n"
  diskStat = { exists: true, mtimeMs: 1000, size: diskContent.length }
  checkCalls = []
  checkResult = { diagnostics: [PY_DIAGNOSTIC], toolsAvailable: true, missing: [] }
})

afterEach(() => {
  vi.clearAllTimers()
})

const DEFAULT_SETTINGS: EditorSettings = {
  autosave: false,
  vim: false,
  typeChecker: "ty",
  formatOnSave: false,
}

function baseHandlers(treeName: string, overrides: FakeHandlers = {}): FakeHandlers {
  return {
    "files.tree": () => [{ name: treeName, relPath: treeName, kind: "file" as const }],
    "files.read": () => ({ exists: diskStat.exists, content: diskContent }),
    "files.stat": () => diskStat,
    "files.write": (input) => {
      const { content } = input as { relPath: string; content: string }
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
    ...overrides,
  }
}

function renderPane(
  handlers: FakeHandlers,
  settings: EditorSettings = DEFAULT_SETTINGS,
  onUpdate?: (patch: Partial<EditorSettings>) => void,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <EditorPane
        client={client}
        workspaceId="ws-1"
        editorSettings={settings}
        onUpdateEditorSettings={onUpdate}
      />
    </AppProviders>,
  )
}

async function openFile() {
  const fileButton = await screen.findByTestId("file-tree-file")
  fireEvent.click(fileButton)
  await screen.findByTestId("editor-buffer")
}

describe("EditorPane diagnostics", () => {
  test("a Python file surfaces diagnostics in the status bar and the buffer", async () => {
    renderPane(baseHandlers("main.py"))
    await openFile()

    // The check ran for the opened Python file with the ty type checker + lint.
    await waitFor(() => expect(checkCalls.length).toBeGreaterThan(0))
    expect(checkCalls[0]).toEqual({ relPath: "main.py", typeChecker: "ty", lint: true })

    // The status bar shows the warning count and the buffer got a diagnostics source.
    await waitFor(() => expect(screen.getByTestId("editor-diagnostics-warnings")).toBeTruthy())
    expect(screen.getByTestId("editor-diagnostics-warnings").textContent).toContain("1")
    await waitFor(() => expect(lastBufferProps.diagnostics).toBeTypeOf("function"))
  })

  test("a non-Python file gets no diagnostics check and no diagnostics source", async () => {
    renderPane(baseHandlers("notes.txt"))
    await openFile()

    // Give any (incorrect) async check a chance to fire, then assert none did.
    await waitFor(() => expect(screen.getByTestId("buffer-path").textContent).toBe("notes.txt"))
    expect(checkCalls).toHaveLength(0)
    expect(screen.queryByTestId("editor-diagnostics-warnings")).toBeNull()
    expect(screen.queryByTestId("editor-diagnostics-count")).toBeNull()
    expect(lastBufferProps.diagnostics).toBeUndefined()
  })

  test("graceful tooling-missing path shows an install hint, not errors", async () => {
    checkResult = { diagnostics: [], toolsAvailable: false, missing: ["ty", "ruff"] }
    renderPane(baseHandlers("main.py"))
    await openFile()

    await waitFor(() => expect(screen.getByTestId("editor-tools-missing")).toBeTruthy())
    expect(screen.queryByTestId("editor-diagnostics-errors")).toBeNull()
    expect(screen.getByTestId("editor-tools-missing").textContent).toContain("install uv")
  })

  test("a re-check fires after a successful save", async () => {
    renderPane(baseHandlers("main.py"))
    await openFile()
    await waitFor(() => expect(checkCalls).toHaveLength(1))

    fireEvent.click(screen.getByTestId("buffer-type"))
    fireEvent.click(screen.getByTestId("buffer-save"))

    // Save → re-check the saved content.
    await waitFor(() => expect(checkCalls).toHaveLength(2))
  })

  test("the type checker setting flows into the check call", async () => {
    renderPane(baseHandlers("main.py"), { ...DEFAULT_SETTINGS, typeChecker: "pyrefly" })
    await openFile()
    await waitFor(() => expect(checkCalls).toHaveLength(1))
    expect(checkCalls[0]?.typeChecker).toBe("pyrefly")
  })
})

describe("EditorPane settings", () => {
  test("vim reflects the setting and passes through to the buffer", async () => {
    renderPane(baseHandlers("main.py"), { ...DEFAULT_SETTINGS, vim: true })
    await openFile()
    expect(screen.getByTestId("buffer-vim").textContent).toBe("true")
    expect(lastBufferProps.vim).toBe(true)
  })

  test("the settings menu round-trips a patch through onUpdate", async () => {
    const onUpdate = vi.fn()
    renderPane(baseHandlers("main.py"), DEFAULT_SETTINGS, onUpdate)
    await screen.findByTestId("file-tree-file")

    fireEvent.click(screen.getByTestId("editor-settings"))
    fireEvent.click(screen.getByTestId("editor-settings-autosave"))
    expect(onUpdate).toHaveBeenCalledWith({ autosave: true })
  })

  test("autosave persists a dirty buffer after the debounce without ⌘S", async () => {
    vi.useFakeTimers()
    try {
      renderPane(baseHandlers("main.py"), { ...DEFAULT_SETTINGS, autosave: true })
      await vi.waitFor(() => expect(screen.queryByTestId("file-tree-file")).toBeTruthy())
      fireEvent.click(screen.getByTestId("file-tree-file"))
      await vi.waitFor(() => expect(screen.queryByTestId("editor-buffer")).toBeTruthy())

      fireEvent.click(screen.getByTestId("buffer-type"))
      await vi.waitFor(() => expect(screen.queryByTestId("editor-dirty")).toBeTruthy())

      // No ⌘S — autosave fires after its debounce and clears the dirty state.
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.waitFor(() => expect(diskContent).toContain("EDIT"))
      await vi.waitFor(() => expect(screen.queryByTestId("editor-dirty")).toBeNull())
    } finally {
      vi.useRealTimers()
    }
  })

  test("format-on-save runs ruff format and reloads the buffer when it changed", async () => {
    let formatCalls = 0
    renderPane(
      baseHandlers("main.py", {
        "diagnostics.format": () => {
          formatCalls++
          // ruff "reformats" the file on disk so the buffer must reload.
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
    // After format-on-save reload, the buffer shows the formatted on-disk content.
    await waitFor(() => expect(screen.getByTestId("buffer-doc").textContent).toContain("formatted"))
  })
})
