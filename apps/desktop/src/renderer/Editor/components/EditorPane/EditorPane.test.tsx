import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createFakeTrpcClient, type FakeHandlers } from "../../../test/fakeTrpcClient"

/**
 * Component test for the editor core's state machine (AGENTS.md §14): open →
 * dirty → ⌘S save → external-change reconcile. The real CodeMirror view needs
 * layout APIs jsdom lacks, so we replace {@link CodeMirrorBuffer} with a tiny
 * stub that exposes its `onChange`/`onSave` props as buttons. That isolates the
 * behaviour under test — buffer/dirty/save/reload logic in `EditorPane` — from
 * CodeMirror's rendering, which gets its own check elsewhere.
 *
 * The stub is hoisted via `vi.mock`; the assertions all go through the public
 * DOM (`data-testid`s) and a faked tRPC client over an in-memory link.
 */
vi.mock("../CodeMirrorBuffer", () => ({
  // Mirror CodeMirror's contract: it seeds its document from `initialDoc` once on
  // mount and never again (live external reloads remount it via a new React
  // `key`). Capturing `initialDoc` in mount-time state reproduces that, so the
  // displayed doc only changes when the parent actually remounts the buffer.
  CodeMirrorBuffer: ({
    relPath,
    initialDoc,
    onChange,
    onSave,
  }: {
    relPath: string
    initialDoc: string
    onChange: (doc: string) => void
    onSave: () => void
  }) => {
    const [seeded] = useState(initialDoc)
    return (
      <div data-testid="editor-buffer">
        <pre data-testid="buffer-doc">{seeded}</pre>
        <span data-testid="buffer-path">{relPath}</span>
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

let written: Array<{ relPath: string; content: string }>
let diskContent: string
let diskStat: { exists: boolean; mtimeMs: number; size: number }

beforeEach(() => {
  written = []
  diskContent = "print('hi')\n"
  diskStat = { exists: true, mtimeMs: 1000, size: diskContent.length }
})

afterEach(() => {
  vi.clearAllTimers()
})

function baseHandlers(overrides: FakeHandlers = {}): FakeHandlers {
  return {
    "files.tree": () => [{ name: "main.py", relPath: "main.py", kind: "file" as const }],
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
    ...overrides,
  }
}

function renderPane(handlers: FakeHandlers) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <EditorPane client={client} workspaceId="ws-1" />
    </AppProviders>,
  )
}

/** Open `main.py` from the file tree and wait for its buffer to mount. */
async function openMainPy() {
  const fileButton = await screen.findByTestId("file-tree-file")
  fireEvent.click(fileButton)
  await screen.findByTestId("editor-buffer")
}

describe("EditorPane", () => {
  test("opening a file shows its content and a tab", async () => {
    renderPane(baseHandlers())
    await openMainPy()

    expect(screen.getByTestId("buffer-doc").textContent).toBe("print('hi')\n")
    expect(screen.getByTestId("editor-tab")).toBeTruthy()
    // Freshly opened ⇒ not dirty.
    expect(screen.queryByTestId("editor-dirty")).toBeNull()
  })

  test("editing marks the tab dirty", async () => {
    renderPane(baseHandlers())
    await openMainPy()

    fireEvent.click(screen.getByTestId("buffer-type"))

    await waitFor(() => {
      expect(screen.getByTestId("editor-dirty")).toBeTruthy()
    })
    expect(screen.getByTestId("editor-tab").getAttribute("data-dirty")).toBe("true")
  })

  test("⌘S writes the buffer and clears the dirty state", async () => {
    renderPane(baseHandlers())
    await openMainPy()

    fireEvent.click(screen.getByTestId("buffer-type"))
    await waitFor(() => expect(screen.getByTestId("editor-dirty")).toBeTruthy())

    fireEvent.click(screen.getByTestId("buffer-save"))

    await waitFor(() => {
      expect(written).toHaveLength(1)
    })
    expect(written[0]).toEqual({ relPath: "main.py", content: "print('hi')\n EDIT" })
    await waitFor(() => {
      expect(screen.queryByTestId("editor-dirty")).toBeNull()
    })
  })

  test("an external change to a CLEAN buffer auto-reloads the content", async () => {
    vi.useFakeTimers()
    try {
      renderPane(baseHandlers())
      // findBy* uses real timers internally; advance manually instead.
      await vi.waitFor(() => expect(screen.queryByTestId("file-tree-file")).toBeTruthy())
      fireEvent.click(screen.getByTestId("file-tree-file"))
      await vi.waitFor(() => expect(screen.queryByTestId("editor-buffer")).toBeTruthy())
      expect(screen.getByTestId("buffer-doc").textContent).toBe("print('hi')\n")

      // Agent/git rewrites the file on disk.
      diskContent = "print('reloaded')\n"
      diskStat = { exists: true, mtimeMs: 5000, size: diskContent.length }

      await vi.advanceTimersByTimeAsync(2_000)

      await vi.waitFor(() => {
        expect(screen.getByTestId("buffer-doc").textContent).toBe("print('reloaded')\n")
      })
      // Auto-reload keeps the buffer clean — no warning, no dirty dot.
      expect(screen.queryByTestId("editor-external-warning")).toBeNull()
      expect(screen.queryByTestId("editor-dirty")).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  test("an external change to a DIRTY buffer warns instead of clobbering", async () => {
    vi.useFakeTimers()
    try {
      renderPane(baseHandlers())
      await vi.waitFor(() => expect(screen.queryByTestId("file-tree-file")).toBeTruthy())
      fireEvent.click(screen.getByTestId("file-tree-file"))
      await vi.waitFor(() => expect(screen.queryByTestId("editor-buffer")).toBeTruthy())

      // User has unsaved edits.
      fireEvent.click(screen.getByTestId("buffer-type"))
      await vi.waitFor(() => expect(screen.queryByTestId("editor-dirty")).toBeTruthy())

      // Disk changes underneath the dirty buffer.
      diskContent = "print('from agent')\n"
      diskStat = { exists: true, mtimeMs: 9000, size: diskContent.length }

      await vi.advanceTimersByTimeAsync(2_000)

      await vi.waitFor(() => {
        expect(screen.getByTestId("editor-external-warning")).toBeTruthy()
      })
      // The user's edit is preserved (no clobber) and stays dirty.
      expect(screen.getByTestId("buffer-doc").textContent).toBe("print('hi')\n")
      expect(screen.getByTestId("editor-dirty")).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  test("closing a tab returns to the empty state", async () => {
    renderPane(baseHandlers())
    await openMainPy()

    fireEvent.click(screen.getByTestId("editor-tab-close"))

    await waitFor(() => {
      expect(screen.getByTestId("editor-empty")).toBeTruthy()
    })
    expect(screen.queryByTestId("editor-tab")).toBeNull()
  })
})
