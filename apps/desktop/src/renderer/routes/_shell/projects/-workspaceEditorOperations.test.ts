import { QueryClient } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, test, vi } from "vitest"
import { DEFAULT_EDITOR_SETTINGS } from "../../../Editor/hooks/useEditorBuffers"
import { AppProviders } from "../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../test/fakeTrpcClient"
import { registerProjectEditor, saveProjectBuffer } from "./-workspaceEditorOperations"
import { WorkspaceRecoveryStore } from "./-workspaceRecovery"
import { useCentralPanel } from "./components/CentralPanel/useCentralPanel"

function setup() {
  const store = new WorkspaceRecoveryStore(window.localStorage)
  store.write(
    "source",
    {
      buffers: [
        {
          relPath: "untitled.md",
          untitled: true,
          content: "draft",
          savedContent: "",
          baseline: { mtimeMs: 0, size: 0 },
          externalChange: false,
          epoch: 0,
        },
      ],
      activeRelPath: "untitled.md",
      active: { type: "file", relPath: "untitled.md" },
      sessions: [],
      belowEditorRun: null,
    },
    "source-ws",
  )
  return store
}

describe("inactive project saves through shared editor operations (mocked IPC)", () => {
  test("an inactive save completing after remount preserves newer drafts and updates their baseline", async () => {
    const store = setup()
    store.updateBuffers("source", (buffers) =>
      buffers.map((buffer) => ({
        ...buffer,
        relPath: "notes.txt",
        untitled: false,
        content: "first draft",
        savedContent: "old",
        baseline: { mtimeMs: 1, size: 3 },
      })),
    )
    let finishWrite!: (result: {
      baseline: { mtimeMs: number; size: number }
      matchesWrittenContent: boolean
    }) => void
    const write = vi.fn(
      () =>
        new Promise((resolve) => {
          finishWrite = resolve
        }),
    )
    const client = createFakeTrpcClient({
      "workspaces.ensureMain": () => ({ id: "source-ws" }),
      "files.stat": () => ({ exists: true, mtimeMs: 1, size: 3 }),
      "files.write": write,
      "agents.list": () => [],
      "agents.projectChoice": () => ({ agentId: null }),
    })
    const saving = saveProjectBuffer(
      store,
      client,
      "source",
      "notes.txt",
      DEFAULT_EDITOR_SETTINGS,
      async () => null,
    )
    await waitFor(() => expect(write).toHaveBeenCalledOnce())
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const initialState = store.read("source", true)
    const view = renderHook(
      () =>
        useCentralPanel({
          client,
          workspaceId: "source-ws",
          projectId: "source",
          settings: DEFAULT_EDITOR_SETTINGS,
          initialState,
          onStateChange: (state) => store.write("source", state, "source-ws"),
          onBuffersChange: (buffers) => store.updateBuffers("source", () => buffers),
        }),
      { wrapper: ({ children }) => createElement(AppProviders, { client, queryClient, children }) },
    )
    const unregister = registerProjectEditor("source", () => view.result.current)
    act(() => {
      view.result.current.editor.onEdit("notes.txt", "newer draft")
      view.result.current.editor.openUntitled("another.txt")
    })
    await act(async () => {
      finishWrite({ baseline: { mtimeMs: 2, size: 11 }, matchesWrittenContent: true })
      await saving
    })
    expect(view.result.current.editor.buffers[0]).toMatchObject({
      content: "newer draft",
      savedContent: "first draft",
      baseline: { mtimeMs: 2, size: 11 },
      externalChange: false,
    })
    expect(store.read("source", true)?.buffers.map((buffer) => buffer.relPath)).toEqual([
      "notes.txt",
      "another.txt",
    ])
    unregister()
    view.unmount()
    queryClient.clear()
    store.dispose()
  })
  test("canceled Save As preserves the inactive draft", async () => {
    const store = setup()
    const write = vi.fn()
    const client = createFakeTrpcClient({ "files.write": write })
    const result = await saveProjectBuffer(
      store,
      client,
      "source",
      "untitled.md",
      DEFAULT_EDITOR_SETTINGS,
      async () => null,
    )
    expect(result.saved).toBe(false)
    expect(write).not.toHaveBeenCalled()
    expect(store.read("source", true)?.buffers[0]?.content).toBe("draft")
    store.dispose()
  })

  test("cross-project Save As moves the written buffer to the selected workspace", async () => {
    const store = setup()
    const write = vi.fn(() => ({ baseline: { mtimeMs: 2, size: 5 }, matchesWrittenContent: true }))
    const client = createFakeTrpcClient({
      "workspaces.ensureMain": () => ({ id: "target-ws" }),
      "files.stat": () => ({ exists: true, mtimeMs: 2, size: 0 }),
      "files.write": write,
    })
    const result = await saveProjectBuffer(
      store,
      client,
      "source",
      "untitled.md",
      DEFAULT_EDITOR_SETTINGS,
      async () => ({ projectId: "target", relPath: "saved.md" }),
    )
    expect(result.saved).toBe(true)
    expect(write).toHaveBeenCalledWith({
      workspaceId: "target-ws",
      relPath: "saved.md",
      content: "draft",
    })
    expect(store.read("source", true)?.buffers).toEqual([])
    expect(store.read("target", true)?.buffers[0]).toMatchObject({
      relPath: "saved.md",
      content: "draft",
      savedContent: "draft",
      untitled: false,
    })
    store.dispose()
  })

  test("an inactive disk conflict blocks saving without overwrite", async () => {
    const store = setup()
    store.updateBuffers("source", (buffers) =>
      buffers.map((buffer) => ({
        ...buffer,
        relPath: "saved.txt",
        untitled: false,
        baseline: { mtimeMs: 1, size: 1 },
      })),
    )
    const write = vi.fn()
    const client = createFakeTrpcClient({
      "files.stat": () => ({ exists: true, mtimeMs: 9, size: 4 }),
      "files.write": write,
    })
    const result = await saveProjectBuffer(
      store,
      client,
      "source",
      "saved.txt",
      DEFAULT_EDITOR_SETTINGS,
      async () => null,
    )
    expect(result.saved).toBe(false)
    expect(result.error).toContain("changed on disk")
    expect(write).not.toHaveBeenCalled()
    expect(store.read("source", true)?.buffers[0]?.externalChange).toBe(true)
    store.dispose()
  })
})

test("delayed cross-project Save As selects a still-open tab after another tab closes", async () => {
  const store = setup()
  const initialState = store.read("source", true)
  const draft = initialState?.buffers[0]
  if (!initialState || !draft) throw new Error("missing source fixture")
  store.write(
    "source",
    {
      ...initialState,
      buffers: [
        { ...draft, relPath: "keep.txt", content: "kept", savedContent: "kept", untitled: false },
        {
          ...draft,
          relPath: "closed.txt",
          content: "closed",
          savedContent: "closed",
          untitled: false,
        },
        draft,
      ],
    },
    "source-ws",
  )
  let finishWrite!: () => void
  const pendingWrite = new Promise<void>((resolve) => {
    finishWrite = resolve
  })
  const write = vi.fn(async () => {
    await pendingWrite
    return { baseline: { mtimeMs: 2, size: 5 }, matchesWrittenContent: true }
  })
  const client = createFakeTrpcClient({
    "agents.list": () => [],
    "agents.projectChoice": () => ({ agentId: null }),
    "workspaces.ensureMain": () => ({ id: "target-ws" }),
    "files.stat": () => ({ exists: true, mtimeMs: 2, size: 0 }),
    "files.write": write,
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const initial = store.read("source", true)
  const view = renderHook(
    () =>
      useCentralPanel({
        client,
        workspaceId: "source-ws",
        projectId: "source",
        settings: DEFAULT_EDITOR_SETTINGS,
        initialState: initial,
        onStateChange: (state) => store.write("source", state, "source-ws"),
        onBuffersChange: (buffers) => store.updateBuffers("source", () => buffers),
      }),
    { wrapper: ({ children }) => createElement(AppProviders, { client, queryClient, children }) },
  )
  const unregister = registerProjectEditor("source", () => view.result.current)
  let saving!: ReturnType<typeof saveProjectBuffer>
  act(() => {
    saving = saveProjectBuffer(
      store,
      client,
      "source",
      "untitled.md",
      DEFAULT_EDITOR_SETTINGS,
      async () => ({ projectId: "target", relPath: "saved.md" }),
    )
  })
  await waitFor(() => expect(write).toHaveBeenCalledOnce())
  act(() => view.result.current.closeFile("closed.txt"))
  await act(async () => {
    finishWrite()
    expect((await saving).saved).toBe(true)
  })
  const selection = view.result.current.active
  unregister()
  view.unmount()
  queryClient.clear()
  store.dispose()
  expect(selection).toEqual({ type: "file", relPath: "keep.txt" })
})
