import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { DEFAULT_EDITOR_SETTINGS } from "../../../Editor/hooks/useEditorBuffers"
import { liveBuffer } from "../../../Editor/hooks/useEditorBuffers/bufferOperations"
import { createFakeTrpcClient } from "../../../test/fakeTrpcClient"
import type { NewFileResult } from "../components/NewFileController"
import { saveProjectBuffer } from "./-workspaceEditorOperations"
import { WorkspaceRecoveryStore } from "./-workspaceRecovery"

let store: WorkspaceRecoveryStore
beforeEach(() => {
  window.localStorage.clear()
  store = new WorkspaceRecoveryStore(window.localStorage)
  store.write(
    "source",
    {
      buffers: [
        liveBuffer({
          relPath: "untitled.md",
          untitled: true,
          content: "original draft",
          savedContent: "",
          baseline: { mtimeMs: 0, size: 0 },
          externalChange: false,
          epoch: 0,
        }),
      ],
      activeRelPath: "untitled.md",
      active: { type: "file", relPath: "untitled.md" },
      sessions: [],
      belowEditorRun: null,
    },
    "source-ws",
  )
})
afterEach(() => store.dispose())

describe("shutdown saves preserve source ownership across mocked IPC and chooser awaits", () => {
  test("a pending Save As cannot save a replacement buffer with the same path", async () => {
    let choose!: (result: NewFileResult | null) => void
    const destination = new Promise<NewFileResult | null>((resolve) => {
      choose = resolve
    })
    const write = vi.fn(() => ({ baseline: { mtimeMs: 2, size: 11 }, matchesWrittenContent: true }))
    const client = createFakeTrpcClient({
      "files.stat": () => ({ exists: true, mtimeMs: 1, size: 0 }),
      "files.write": write,
    })
    const saving = saveProjectBuffer(
      store,
      client,
      "source",
      "untitled.md",
      DEFAULT_EDITOR_SETTINGS,
      () => destination,
    )
    store.updateBuffers("source", (buffers) =>
      buffers.map((buffer) => liveBuffer({ ...buffer, content: "replacement" })),
    )
    choose({ projectId: "source", relPath: "chosen.md" })
    const result = await saving
    expect(result.saved).toBe(false)
    expect(write).not.toHaveBeenCalled()
    expect(store.read("source", true)?.buffers[0]).toMatchObject({
      relPath: "untitled.md",
      content: "replacement",
    })
  })
})
