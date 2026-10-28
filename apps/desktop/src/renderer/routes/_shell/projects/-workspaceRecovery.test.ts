import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { RECOVERY_PREFIX, WorkspaceRecoveryStore } from "./-workspaceRecovery"
import type { CentralPanelRestoreState } from "./components/CentralPanel/useCentralPanel"

function state(content: string): CentralPanelRestoreState {
  return {
    buffers: [
      {
        relPath: "notes.txt",
        content,
        savedContent: "saved",
        baseline: { mtimeMs: 1, size: 5 },
        externalChange: false,
        epoch: 0,
      },
    ],
    activeRelPath: "notes.txt",
    sessions: [],
    active: { type: "file", relPath: "notes.txt" },
    belowEditorRun: null,
  }
}

beforeEach(() => {
  window.localStorage.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("project recovery storage", () => {
  test("debounces only the edited project, skips unchanged state and caps continuous typing delay", () => {
    const store = new WorkspaceRecoveryStore(window.localStorage)
    const write = vi.spyOn(window.localStorage, "setItem")
    store.write("a", state("first"))
    store.write("b", state("other"))
    vi.advanceTimersByTime(500)
    expect(write).toHaveBeenCalledTimes(2)
    write.mockClear()
    const same = state("first")
    store.write("a", same)
    vi.advanceTimersByTime(500)
    expect(write).not.toHaveBeenCalled()
    for (let i = 0; i < 5; i++) {
      store.write("a", state(`edit ${i}`))
      vi.advanceTimersByTime(400)
    }
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0]).toBe(`${RECOVERY_PREFIX}a`)
    store.dispose()
  })

  test("retains clean contents and disabled restoration keeps live inactive edits", () => {
    const store = new WorkspaceRecoveryStore(window.localStorage)
    const clean = state("saved")
    store.write("a", clean)
    store.flush()
    expect(
      new WorkspaceRecoveryStore(window.localStorage).read("a", true)?.buffers[0]?.content,
    ).toBe("saved")
    store.write("a", state("live draft"))
    expect(store.read("a", false)?.buffers[0]?.content).toBe("live draft")
    expect(new WorkspaceRecoveryStore(window.localStorage).read("a", false)?.buffers).toEqual([])
    store.dispose()
  })

  test("the split layout is saved with the tabs and follows tab restoration", () => {
    const store = new WorkspaceRecoveryStore(window.localStorage)
    const layout = {
      grid: { root: {}, height: 1, width: 1, orientation: "HORIZONTAL" },
      panels: {},
    }
    store.write("a", { ...state("saved"), layout } as CentralPanelRestoreState)
    store.flush()
    expect(new WorkspaceRecoveryStore(window.localStorage).read("a", true)?.layout).toEqual(layout)
    expect(new WorkspaceRecoveryStore(window.localStorage).read("a", false)?.layout).toBeNull()
    store.dispose()
  })

  test("limits UTF8 current and baseline independently and reports unprotected current edits", () => {
    const store = new WorkspaceRecoveryStore(window.localStorage)
    store.write("a", state("é".repeat(500_000)))
    store.flush()
    expect(store.affected(true)).toEqual([])
    store.write("a", state("é".repeat(500_001)))
    store.flush()
    expect(store.affected(true)).toHaveLength(1)
    const restored = new WorkspaceRecoveryStore(window.localStorage).read("a", true)
    expect(restored?.buffers).toEqual([])
    expect(restored?.omittedBuffers?.[0]?.relPath).toBe("notes.txt")
    const oversizedBaseline = state("small")
    oversizedBaseline.buffers = oversizedBaseline.buffers.map((buffer) => ({
      ...buffer,
      savedContent: "a".repeat(1_000_001),
    }))
    store.write("b", oversizedBaseline)
    store.flush()
    expect(store.affected(true)).toHaveLength(2)
    store.dispose()
  })

  test("budget and mocked quota failures preserve last successful snapshot", () => {
    const store = new WorkspaceRecoveryStore(window.localStorage)
    store.write("a", state("old draft"))
    store.flush()
    const previous = window.localStorage.getItem(`${RECOVERY_PREFIX}a`)
    store.write("b", state("x".repeat(1_000_000)))
    store.flush()
    store.write("a", state("y".repeat(1_000_000)))
    store.flush()
    // Current and baseline remain under the per-file limit, but escaped UTF16 JSON crosses the budget.
    const huge = state("\u0000".repeat(400_000))
    store.write("a", huge)
    store.flush()
    expect(store.affected(true).some((item) => item.projectId === "a")).toBe(true)
    expect(store.warnings().join(" ")).toContain("4 MiB")
    expect(window.localStorage.getItem(`${RECOVERY_PREFIX}a`)).not.toContain("\\u0000")
    const retained = window.localStorage.getItem(`${RECOVERY_PREFIX}a`)
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError")
    })
    store.write("a", state("latest"))
    store.flush()
    expect(window.localStorage.getItem(`${RECOVERY_PREFIX}a`) === retained).toBe(true)
    expect(store.affected(true).find((item) => item.projectId === "a")?.buffer.content).toBe(
      "latest",
    )
    expect(previous).toContain("old draft")
    store.dispose()
  })

  test("discard removes old affected drafts while preserving other protected buffers", () => {
    const store = new WorkspaceRecoveryStore(window.localStorage)
    const original = state("old draft")
    const first = original.buffers[0]
    if (!first) throw new Error("missing fixture buffer")
    const second = { ...first, relPath: "keep.txt", content: "keep draft" }
    original.buffers.push(second)
    store.write("a", original)
    store.flush()
    const latest = {
      ...original,
      buffers: [{ ...first, content: "x".repeat(1_000_001) }, second],
    }
    store.write("a", latest)
    const affected = store.affected(true)
    expect(store.discard(affected)).toBe(true)
    const restored = new WorkspaceRecoveryStore(window.localStorage).read("a", true)
    expect(restored?.buffers.map((buffer) => buffer.relPath)).toEqual(["keep.txt"])
    expect(window.localStorage.getItem(`${RECOVERY_PREFIX}a`)).not.toContain("old draft")
    store.dispose()
  })
})

test("corrupt first project does not prevent later restoration or count outside the storage budget", () => {
  window.localStorage.setItem(`${RECOVERY_PREFIX}bad`, "x".repeat(1_000_000))
  const writer = new WorkspaceRecoveryStore(window.localStorage)
  writer.write("good", state("restorable"))
  writer.flush()
  const restored = new WorkspaceRecoveryStore(window.localStorage)
  expect(restored.read("good", true)?.buffers[0]?.content).toBe("restorable")
  restored.write("large", state("y".repeat(1_000_000)))
  restored.flush()
  restored.write("overflow", state("z".repeat(200_000)))
  restored.flush()
  expect(window.localStorage.getItem(`${RECOVERY_PREFIX}overflow`)).toBeNull()
  expect(restored.warnings().join(" ")).toContain("4 MiB")
  writer.dispose()
  restored.dispose()
})

test("mocked cleanup quota failure preserves affected and protected recovery drafts", () => {
  const store = new WorkspaceRecoveryStore(window.localStorage)
  const original = state("draft")
  store.write("a", original)
  store.flush()
  const previous = window.localStorage.getItem(`${RECOVERY_PREFIX}a`)
  store.write("a", state("latest unprotected draft"))
  const affected = store.affected(true)
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw new DOMException("quota", "QuotaExceededError")
  })
  expect(store.discard(affected)).toBe(false)
  expect(window.localStorage.getItem(`${RECOVERY_PREFIX}a`)).toBe(previous)
  expect(store.read("a", true)?.buffers[0]?.content).toBe("latest unprotected draft")
  store.dispose()
})

test("excluded untitled contents restore as a visible omission, never a blank editable draft", () => {
  const store = new WorkspaceRecoveryStore(window.localStorage)
  const draft = state("é".repeat(500_001))
  draft.buffers = draft.buffers.map((buffer) => ({
    ...buffer,
    relPath: "untitled.md",
    untitled: true,
  }))
  store.write("a", draft)
  store.flush()
  const restored = new WorkspaceRecoveryStore(window.localStorage)
  expect(restored.read("a", true)?.buffers).toEqual([])
  expect(restored.read("a", true)?.omittedBuffers?.[0]).toMatchObject({
    relPath: "untitled.md",
    untitled: true,
  })
  expect(restored.warnings().join(" ")).toContain("untitled.md")
  store.dispose()
})
