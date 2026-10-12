import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createFakeTrpcClient, type FakeHandlers } from "../../../test/fakeTrpcClient"
import { DEFAULT_EDITOR_SETTINGS, type OpenBuffer, useEditorBuffers } from "./useEditorBuffers"

/** Deferred mocked IPC boundaries make response ordering deterministic. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const initial: OpenBuffer = {
  relPath: "notes.txt",
  content: "old",
  savedContent: "old",
  baseline: { mtimeMs: 1, size: 3 },
  externalChange: false,
  epoch: 0,
}

function setup(handlers: FakeHandlers, buffer: OpenBuffer, formatOnSave: boolean) {
  const stat = handlers["files.stat"] ?? (() => ({ exists: true, mtimeMs: 1, size: 3 }))
  const read = handlers["files.read"] ?? (() => ({ exists: true, content: "disk" }))
  const write = handlers["files.write"] ?? (() => ({ bytes: 3 }))
  const client = createFakeTrpcClient({
    "python.resolve": () => null,
    ...handlers,
    "files.stat": stat,
    "files.read": async (input) => {
      const result = (await read(input)) as Record<string, unknown>
      return {
        status: result.status ?? (result.exists ? "text" : "missing"),
        ...result,
        baseline: result.baseline ?? (await stat(input)),
      }
    },
    "files.write": async (input) => {
      const result = (await write(input)) as Record<string, unknown>
      return {
        ...result,
        baseline: result.baseline ?? (await stat(input)),
        matchesWrittenContent: result.matchesWrittenContent ?? true,
      }
    },
  })
  return renderHook(() =>
    useEditorBuffers({
      client,
      workspaceId: "race-test",
      initialBuffers: [buffer],
      initialActiveRelPath: buffer.relPath,
      settings: {
        ...DEFAULT_EDITOR_SETTINGS,
        diagnosticsEnabled: false,
        autosave: false,
        formatOnSave,
      },
    }),
  )
}

afterEach(() => vi.useRealTimers())

describe("editor races (deferred mocked IPC)", () => {
  test("late save records the exact written text and reports newer edits unsaved", async () => {
    const write = deferred<{ bytes: number }>()
    const view = setup({ "files.write": () => write.promise }, initial, false)
    act(() => view.result.current.onEdit("notes.txt", "first"))
    let saving!: Promise<boolean>
    act(() => {
      saving = view.result.current.saveFile("notes.txt")
    })
    await act(async () => {
      await Promise.resolve()
    })
    act(() => view.result.current.onEdit("notes.txt", "second"))
    let saved: boolean | undefined
    await act(async () => {
      write.resolve({ bytes: 5 })
      saved = await saving
    })
    expect(view.result.current.active).toMatchObject({ content: "second", savedContent: "first" })
    expect(saved).toBe(false)
  })

  test("Save As preserves edits made while saving and their dirty state", async () => {
    const write = deferred<{ bytes: number }>()
    const view = setup(
      {
        "files.write": () => write.promise,
        "files.stat": () => ({ exists: true, mtimeMs: 1, size: 0 }),
      },
      initial,
      false,
    )
    act(() => view.result.current.onEdit("notes.txt", "first"))
    let saving!: Promise<boolean>
    act(() => {
      saving = view.result.current.saveAs("notes.txt", "new.txt")
    })
    await act(async () => {
      await Promise.resolve()
    })
    act(() => view.result.current.onEdit("notes.txt", "second"))
    await act(async () => {
      write.resolve({ bytes: 5 })
      await saving
    })
    expect(view.result.current.active).toMatchObject({
      relPath: "new.txt",
      content: "second",
      savedContent: "first",
    })
  })

  test("late formatting preserves newer edits and exposes a conflict", async () => {
    const formatting = deferred<{ changed: boolean }>()
    const format = vi.fn(() => formatting.promise)
    const view = setup(
      {
        "diagnostics.format": format,
        "files.read": () => ({ exists: true, content: "formatted" }),
      },
      { ...initial, relPath: "main.py" },
      true,
    )
    act(() => view.result.current.onEdit("main.py", "first"))
    let saving!: Promise<boolean>
    act(() => {
      saving = view.result.current.saveFile("main.py")
    })
    await act(async () => {
      await vi.waitFor(() => expect(format).toHaveBeenCalled())
    })
    act(() => view.result.current.onEdit("main.py", "second"))
    await act(async () => {
      formatting.resolve({ changed: true })
      await saving
    })
    expect(view.result.current.active).toMatchObject({
      content: "second",
      savedContent: "formatted",
      externalChange: true,
    })
  })

  test("late external reload preserves a newer edit and exposes a conflict", async () => {
    vi.useFakeTimers()
    const read = deferred<{ exists: boolean; content: string }>()
    const readCall = vi.fn(() => read.promise)
    const view = setup(
      { "files.stat": () => ({ exists: true, mtimeMs: 2, size: 4 }), "files.read": readCall },
      initial,
      false,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500)
    })
    expect(readCall).toHaveBeenCalled()
    act(() => view.result.current.onEdit("notes.txt", "second"))
    await act(async () => {
      read.resolve({ exists: true, content: "disk" })
      await Promise.resolve()
    })
    expect(view.result.current.active).toMatchObject({
      content: "second",
      savedContent: "old",
      externalChange: true,
    })
  })

  test("a completed save cannot alter a closed and reopened buffer", async () => {
    const stat = deferred<{ exists: boolean; mtimeMs: number; size: number }>()
    let calls = 0
    const view = setup(
      {
        "files.stat": () => (++calls === 1 ? { exists: true, mtimeMs: 1, size: 3 } : stat.promise),
      },
      initial,
      false,
    )
    act(() => view.result.current.onEdit("notes.txt", "first"))
    let saving!: Promise<boolean>
    act(() => {
      saving = view.result.current.saveFile("notes.txt")
    })
    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      view.result.current.closeFile("notes.txt")
      view.result.current.openUntitled("notes.txt")
      view.result.current.onEdit("notes.txt", "new instance")
    })
    await act(async () => {
      stat.resolve({ exists: true, mtimeMs: 2, size: 5 })
      await saving
    })
    expect(view.result.current.active).toMatchObject({ content: "new instance", savedContent: "" })
  })

  test("same-path saves wait for preceding writes including across hook remount", async () => {
    const write = deferred<{ bytes: number }>()
    const firstWrite = vi.fn(() => write.promise)
    const first = setup({ "files.write": firstWrite }, initial, false)
    act(() => first.result.current.onEdit("notes.txt", "first"))
    let saving!: Promise<boolean>
    act(() => {
      saving = first.result.current.saveFile("notes.txt")
    })
    await act(async () => {
      await vi.waitFor(() => expect(firstWrite).toHaveBeenCalled())
    })
    first.unmount()
    const secondWrite = vi.fn(() => ({ bytes: 6 }))
    const second = setup({ "files.write": secondWrite }, { ...initial, content: "second" }, false)
    let secondSaving!: Promise<boolean>
    act(() => {
      secondSaving = second.result.current.saveFile("notes.txt")
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(secondWrite).not.toHaveBeenCalled()
    await act(async () => {
      write.resolve({ bytes: 5 })
      await saving
      await secondSaving
    })
    expect(secondWrite).toHaveBeenCalledOnce()
  })

  test("conflicting saves remain blocked until an explicit resolution", async () => {
    const write = vi.fn(() => ({ bytes: 5 }))
    const view = setup(
      { "files.write": write },
      { ...initial, content: "local", externalChange: true },
      false,
    )
    let saved: boolean | undefined
    await act(async () => {
      saved = await view.result.current.saveFile("notes.txt")
    })
    expect(saved).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})

test("queued older saves cannot undo an explicit reload (deferred mocked IPC)", async () => {
  const read = deferred<{ exists: boolean; content: string }>()
  const readCall = vi.fn(() => read.promise)
  const write = vi.fn(() => ({ bytes: 3 }))
  const view = setup(
    { "files.read": readCall, "files.write": write },
    { ...initial, content: "local" },
    false,
  )
  let loading!: Promise<boolean>
  act(() => {
    loading = view.result.current.reloadFile("notes.txt")
  })
  await act(async () => {
    await vi.waitFor(() => expect(readCall).toHaveBeenCalled())
  })
  let saving!: Promise<boolean>
  act(() => {
    saving = view.result.current.saveFile("notes.txt")
  })
  await act(async () => {
    read.resolve({ exists: true, content: "disk" })
    await loading
    await saving
  })
  expect(write).not.toHaveBeenCalled()
  expect(view.result.current.active).toMatchObject({ content: "disk", savedContent: "disk" })
})

test.each([
  "saveAs",
  "format",
  "reload",
] as const)("late %s cannot change a reopened instance (deferred mocked IPC)", async (kind) => {
  const boundary = deferred<void>()
  const reached = vi.fn(async () => {
    await boundary.promise
    return { exists: true, content: "late disk", changed: true, bytes: 3 }
  })
  const relPath = kind === "format" ? "main.py" : "notes.txt"
  const view = setup(
    {
      "files.stat": (input) => ({
        exists: true,
        mtimeMs: 1,
        size: (input as { relPath: string }).relPath === "new.txt" ? 0 : 3,
      }),
      [kind === "saveAs" ? "files.write" : kind === "format" ? "diagnostics.format" : "files.read"]:
        reached,
    },
    { ...initial, relPath },
    kind === "format",
  )
  let operation!: Promise<boolean>
  act(() => {
    operation =
      kind === "saveAs"
        ? view.result.current.saveAs(relPath, "new.txt")
        : kind === "format"
          ? view.result.current.saveFile(relPath)
          : view.result.current.reloadFile(relPath)
  })
  await act(async () => {
    await vi.waitFor(() => expect(reached).toHaveBeenCalled())
  })
  act(() => view.result.current.closeFile(relPath))
  act(() => view.result.current.openUntitled(relPath))
  act(() => view.result.current.onEdit(relPath, "reopened edit"))
  let saved: boolean | undefined
  await act(async () => {
    boundary.resolve()
    saved = await operation
  })
  expect(saved).toBe(false)
  expect(view.result.current.active).toMatchObject({
    relPath,
    content: "reopened edit",
    savedContent: "",
    externalChange: false,
  })
})

test("writes wait for formatter completion on the same destination (deferred mocked IPC)", async () => {
  const formatting = deferred<{ changed: boolean }>()
  const format = vi.fn(() => formatting.promise)
  const write = vi.fn(() => ({ bytes: 3 }))
  const view = setup(
    { "files.write": write, "diagnostics.format": format },
    { ...initial, relPath: "main.py" },
    true,
  )
  let first!: Promise<boolean>
  act(() => {
    first = view.result.current.saveFile("main.py")
  })
  await act(async () => {
    await vi.waitFor(() => expect(format).toHaveBeenCalled())
  })
  act(() => view.result.current.onEdit("main.py", "second"))
  let second!: Promise<boolean>
  act(() => {
    second = view.result.current.saveFile("main.py")
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(write).toHaveBeenCalledTimes(1)
  await act(async () => {
    formatting.resolve({ changed: false })
    await first
    await second
  })
  expect(write).toHaveBeenCalledTimes(2)
  expect(view.result.current.active).toMatchObject({ content: "second", savedContent: "second" })
})

test.each([
  "save",
  "saveAs",
] as const)("%s detects an external replacement before post-write verification (mocked IPC)", async (kind) => {
  let disk = "old"
  let mtimeMs = 1
  const writes = vi.fn((input: unknown) => {
    const text = (input as { content: string }).content
    disk = "external replacement"
    mtimeMs += 1
    return {
      bytes: text.length,
      baseline: { mtimeMs, size: disk.length },
      matchesWrittenContent: false,
    }
  })
  const view = setup(
    {
      "files.stat": (input) => ({
        exists: true,
        mtimeMs,
        size:
          kind === "saveAs" && mtimeMs === 1 && (input as { relPath: string }).relPath === "new.txt"
            ? 0
            : disk.length,
      }),
      "files.write": writes,
    },
    initial,
    false,
  )
  act(() => view.result.current.onEdit("notes.txt", "local first"))
  let saved: boolean | undefined
  await act(async () => {
    saved =
      kind === "save"
        ? await view.result.current.saveFile("notes.txt")
        : await view.result.current.saveAs("notes.txt", "new.txt")
  })
  expect(saved).toBe(false)
  expect(view.result.current.active).toMatchObject({
    content: "local first",
    savedContent: "local first",
    externalChange: true,
  })
  const path = kind === "save" ? "notes.txt" : "new.txt"
  expect(view.result.current.tabs).toEqual([{ relPath: path, dirty: true }])
  act(() => view.result.current.onEdit(path, "local second"))
  await act(async () => {
    await view.result.current.saveFile(path)
  })
  expect(writes).toHaveBeenCalledOnce()
  expect(disk).toBe("external replacement")
})

test("opening uses the fingerprint paired with the returned text (mocked IPC)", async () => {
  const write = vi.fn(() => ({ bytes: 3 }))
  const view = setup(
    {
      "files.read": () => ({
        exists: true,
        content: "read text",
        baseline: { mtimeMs: 2, size: 9 },
      }),
      "files.stat": () => ({ exists: true, mtimeMs: 3, size: 14 }),
      "files.write": write,
    },
    initial,
    false,
  )
  await act(async () => {
    await view.result.current.openFile("another.txt")
  })
  act(() => view.result.current.onEdit("another.txt", "local edit"))
  await act(async () => {
    await view.result.current.saveFile("another.txt")
  })
  expect(write).not.toHaveBeenCalled()
  expect(view.result.current.active?.externalChange).toBe(true)
})

test("Python typing preserves the diagnostics source until file identity or results change", async () => {
  const client = createFakeTrpcClient({
    "python.resolve": () => null,
    "diagnostics.check": () => ({ diagnostics: [], toolsAvailable: true, missing: [] }),
  })
  const view = renderHook(() =>
    useEditorBuffers({
      client,
      workspaceId: "diagnostics-stability",
      settings: { ...DEFAULT_EDITOR_SETTINGS, diagnosticsEnabled: true, autosave: false },
      initialBuffers: [{ ...initial, relPath: "module.py" }],
      initialActiveRelPath: "module.py",
    }),
  )
  await act(async () => {
    await Promise.resolve()
  })
  const source = view.result.current.diagnosticsSource
  expect(source).toBeTypeOf("function")
  act(() => view.result.current.onEdit("module.py", "new Python content"))
  expect(view.result.current.diagnosticsSource).toBe(source)
})

describe("bounded editor outcomes (mocked IPC)", () => {
  const rejected = {
    status: "oversized",
    exists: true,
    size: 10_000_001,
    limit: 10_000_000,
    baseline: { exists: true, mtimeMs: 9, size: 10_000_001 },
  }
  test("rejected open creates no buffer and preserves the active draft", async () => {
    const view = setup({ "files.read": () => rejected }, initial, false)
    act(() => view.result.current.onEdit(initial.relPath, "draft"))
    await act(async () => {
      await view.result.current.openFile("large.txt")
    })
    expect(view.result.current.buffers).toHaveLength(1)
    expect(view.result.current.active).toMatchObject({
      content: "draft",
      savedContent: "old",
      baseline: initial.baseline,
    })
    expect(view.result.current.rejectedRead).toMatchObject({
      relPath: "large.txt",
      size: 10_000_001,
    })
  })
  test.each([
    "oversized",
    "binary",
  ])("rejected %s reload preserves draft and baseline and pauses saving", async (status) => {
    const view = setup({ "files.read": () => ({ ...rejected, status }) }, initial, false)
    act(() => view.result.current.onEdit(initial.relPath, "draft"))
    let result: boolean | undefined
    await act(async () => {
      result = await view.result.current.reloadFile(initial.relPath)
    })
    expect(result).toBe(false)
    expect(view.result.current.active).toMatchObject({
      content: "draft",
      savedContent: "old",
      baseline: initial.baseline,
      externalChange: true,
    })
    expect(view.result.current.rejectedRead?.status).toBe(status)
  })
  test("rejected formatter reload preserves draft and old baseline after the write", async () => {
    const buffer = { ...initial, relPath: "main.py" }
    const view = setup(
      { "files.read": () => rejected, "diagnostics.format": () => ({ changed: true }) },
      buffer,
      true,
    )
    act(() => view.result.current.onEdit(buffer.relPath, "draft"))
    let result: boolean | undefined
    await act(async () => {
      result = await view.result.current.saveFile(buffer.relPath)
    })
    expect(result).toBe(false)
    expect(view.result.current.active).toMatchObject({
      content: "draft",
      savedContent: "old",
      baseline: initial.baseline,
      externalChange: true,
    })
  })
})
