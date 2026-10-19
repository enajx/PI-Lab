import { QueryClient } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { QuickEditBridge } from "../../../../shared/quickEdit"
import type { ShutdownRequest } from "../../../../shared/shutdown"
import { withFileOperation } from "../../../Editor/hooks/useEditorBuffers/fileOperations"
import { AppProviders } from "../../../providers/AppProviders"
import {
  closeQuickBuffer,
  readDirtyQuickBuffers,
  readUntitledDraft,
  writeQuickBuffer,
  writeUntitledDraft,
} from "../../../QuickEditor/quickEditorState"
import { createFakeTrpcClient } from "../../../test/fakeTrpcClient"
import { WorkspaceRecoveryStore } from "../projects/-workspaceRecovery"
import { WorkspaceRecoveryController } from "./WorkspaceRecoveryController"

let store: WorkspaceRecoveryStore
const chooseNewFile = vi.hoisted(() => vi.fn())
vi.mock("../projects/-workspaceState", () => ({ workspaceRecovery: () => store }))
vi.mock("./NewFileController", () => ({ useNewFileController: () => ({ chooseNewFile }) }))

beforeEach(() => {
  window.localStorage.clear()
  window.location.hash = "#/"
  writeUntitledDraft("")
  chooseNewFile.mockReset()
  store = new WorkspaceRecoveryStore(window.localStorage)
})
afterEach(() => {
  cleanup()
  store.dispose()
  delete window.piLab
  writeUntitledDraft("")
  closeQuickBuffer("hidden-quick")
})

describe("normal close with existing editor writes and mocked shutdown IPC", () => {
  test("a hidden outside-project file saves before shutdown is approved", async () => {
    writeQuickBuffer({
      target: { id: "hidden-quick", path: "/tmp/hidden.py" },
      content: "edited",
      savedContent: "original",
      baseline: { exists: true, mtimeMs: 1, size: 8 },
      epoch: 0,
      conflict: false,
    })
    let receive!: (request: ShutdownRequest) => void
    const respond = vi.fn()
    const quickSave = vi.fn(async () => ({
      status: "saved" as const,
      baseline: { exists: true, mtimeMs: 2, size: 6 },
    }))
    window.piLab = {
      platform: "darwin",
      shutdown: {
        subscribe: (listener) => {
          receive = listener
          return () => {}
        },
        respond,
      },
      quickEdit: { save: quickSave } as unknown as QuickEditBridge,
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders
        client={createFakeTrpcClient({ "settings.get": () => ({}) })}
        queryClient={queryClient}
      >
        <WorkspaceRecoveryController />
      </AppProviders>,
    )
    await act(async () => receive({ requestId: "quick-file", intent: "close" }))
    await screen.findByRole("dialog", { name: "Unsaved changes" })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save affected" })))
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith({ requestId: "quick-file", allow: true }),
    )
    expect(quickSave).toHaveBeenCalledWith(
      "hidden-quick",
      "edited",
      { exists: true, mtimeMs: 1, size: 8 },
      false,
    )
    expect(readDirtyQuickBuffers()).toEqual([])
    queryClient.clear()
  })

  test("a hidden Untitled draft prevents shutdown until the user decides", async () => {
    writeUntitledDraft("unsaved text")
    let receive!: (request: ShutdownRequest) => void
    const respond = vi.fn()
    window.piLab = {
      platform: "darwin",
      shutdown: {
        subscribe: (listener) => {
          receive = listener
          return () => {}
        },
        respond,
      },
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders
        client={createFakeTrpcClient({ "settings.get": () => ({}) })}
        queryClient={queryClient}
      >
        <WorkspaceRecoveryController />
      </AppProviders>,
    )
    await act(async () => receive({ requestId: "hidden-untitled", intent: "quit" }))
    await screen.findByRole("dialog", { name: "Unsaved changes" })
    expect(respond).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(respond).toHaveBeenCalledWith({ requestId: "hidden-untitled", allow: false })
    expect(readUntitledDraft()).toBe("unsaved text")
    queryClient.clear()
  })

  test("cancelling the native Untitled save keeps the draft and close request", async () => {
    writeUntitledDraft("unsaved text")
    let receive!: (request: ShutdownRequest) => void
    const respond = vi.fn()
    const saveUntitled = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      path: "/tmp/saved.txt",
      route: "/quick-edit?target=saved",
    })
    window.piLab = {
      platform: "darwin",
      shutdown: {
        subscribe: (listener) => {
          receive = listener
          return () => {}
        },
        respond,
      },
      quickEdit: { saveUntitled } as unknown as QuickEditBridge,
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders
        client={createFakeTrpcClient({ "settings.get": () => ({}) })}
        queryClient={queryClient}
      >
        <WorkspaceRecoveryController />
      </AppProviders>,
    )
    await act(async () => receive({ requestId: "untitled-save", intent: "quit" }))
    await screen.findByRole("dialog", { name: "Unsaved changes" })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save affected" })))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save to any path" })))
    expect(respond).not.toHaveBeenCalled()
    expect(readUntitledDraft()).toBe("unsaved text")
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save affected" })))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save to any path" })))
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith({ requestId: "untitled-save", allow: true }),
    )
    expect(readUntitledDraft()).toBe("")
    queryClient.clear()
  })

  test("cancelling the project destination keeps the Untitled draft and close request", async () => {
    writeUntitledDraft("project draft")
    chooseNewFile.mockResolvedValue(null)
    let receive!: (request: ShutdownRequest) => void
    const respond = vi.fn()
    window.piLab = {
      platform: "darwin",
      shutdown: {
        subscribe: (listener) => {
          receive = listener
          return () => {}
        },
        respond,
      },
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders
        client={createFakeTrpcClient({ "settings.get": () => ({}) })}
        queryClient={queryClient}
      >
        <WorkspaceRecoveryController />
      </AppProviders>,
    )
    await act(async () => receive({ requestId: "project-choice", intent: "close" }))
    await screen.findByRole("dialog", { name: "Unsaved changes" })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save affected" })))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save in project" })))
    expect(chooseNewFile).toHaveBeenCalledWith("")
    expect(screen.queryByRole("dialog", { name: "Save Untitled" })).toBeNull()
    expect(screen.getByRole("dialog", { name: "Unsaved changes" })).toBeTruthy()
    expect(readUntitledDraft()).toBe("project draft")
    expect(respond).not.toHaveBeenCalled()
    queryClient.clear()
  })

  test("saving a hidden Untitled draft inside a project approves close after disk verification", async () => {
    writeUntitledDraft("project draft")
    chooseNewFile.mockResolvedValue({ projectId: "project-one", relPath: "notes/draft.py" })
    let receive!: (request: ShutdownRequest) => void
    const respond = vi.fn()
    window.piLab = {
      platform: "darwin",
      shutdown: {
        subscribe: (listener) => {
          receive = listener
          return () => {}
        },
        respond,
      },
    }
    const ensureMain = vi.fn(() => ({ id: "main-workspace" }))
    const write = vi.fn(() => ({ matchesWrittenContent: true }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders
        client={createFakeTrpcClient({
          "settings.get": () => ({}),
          "workspaces.ensureMain": ensureMain,
          "files.write": write,
        })}
        queryClient={queryClient}
      >
        <WorkspaceRecoveryController />
      </AppProviders>,
    )
    await act(async () => receive({ requestId: "project-save", intent: "close" }))
    await screen.findByRole("dialog", { name: "Unsaved changes" })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save affected" })))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save in project" })))
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith({ requestId: "project-save", allow: true }),
    )
    expect(ensureMain).toHaveBeenCalledWith({ projectId: "project-one" })
    expect(write).toHaveBeenCalledWith({
      workspaceId: "main-workspace",
      relPath: "notes/draft.py",
      content: "project draft",
    })
    expect(readUntitledDraft()).toBe("")
    queryClient.clear()
  })
  test("a protected draft cannot approve shutdown before an existing file operation settles", async () => {
    store.write(
      "source",
      {
        buffers: [
          {
            relPath: "notes.txt",
            content: "draft",
            savedContent: "saved",
            baseline: { mtimeMs: 1, size: 5 },
            externalChange: false,
            epoch: 0,
          },
        ],
        activeRelPath: "notes.txt",
        active: { type: "file", relPath: "notes.txt" },
        sessions: [],
        belowEditorRun: null,
      },
      "source-ws",
    )
    store.flush()
    expect(store.affected(true)).toEqual([])
    let receive!: (request: ShutdownRequest) => void
    const respond = vi.fn()
    window.piLab = {
      platform: "darwin",
      shutdown: {
        subscribe: (listener) => {
          receive = listener
          return () => {}
        },
        respond,
      },
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders
        client={createFakeTrpcClient({ "settings.get": () => ({}) })}
        queryClient={queryClient}
      >
        <WorkspaceRecoveryController />
      </AppProviders>,
    )
    let release!: () => void
    const diskWrite = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = false
    const saving = withFileOperation("source-ws", "notes.txt", async () => {
      started = true
      await diskWrite
    })
    await waitFor(() => expect(started).toBe(true))
    await act(async () => {
      receive({ requestId: "closing", intent: "close" })
    })
    const premature = respond.mock.calls.length
    await act(async () => {
      release()
      await saving
    })
    await waitFor(() => expect(respond).toHaveBeenCalledWith({ requestId: "closing", allow: true }))
    expect(premature).toBe(0)
    queryClient.clear()
  })
  test("Discard waits for an operation started while the unsaved-changes dialog is open", async () => {
    store.write(
      "source",
      {
        buffers: [
          {
            relPath: "notes.txt",
            content: "x".repeat(1_000_001),
            savedContent: "saved",
            baseline: { mtimeMs: 1, size: 5 },
            externalChange: false,
            epoch: 0,
          },
        ],
        activeRelPath: "notes.txt",
        active: { type: "file", relPath: "notes.txt" },
        sessions: [],
        belowEditorRun: null,
      },
      "source-ws",
    )
    let receive!: (request: ShutdownRequest) => void
    const respond = vi.fn()
    window.piLab = {
      platform: "darwin",
      shutdown: {
        subscribe: (listener) => {
          receive = listener
          return () => {}
        },
        respond,
      },
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders
        client={createFakeTrpcClient({ "settings.get": () => ({}) })}
        queryClient={queryClient}
      >
        <WorkspaceRecoveryController />
      </AppProviders>,
    )
    await act(async () => {
      receive({ requestId: "discarding", intent: "quit" })
    })
    await screen.findByRole("dialog", { name: "Unsaved changes" })
    let release!: () => void
    const diskWrite = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = false
    const saving = withFileOperation("source-ws", "notes.txt", async () => {
      started = true
      await diskWrite
    })
    await waitFor(() => expect(started).toBe(true))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Discard affected" }))
    })
    const premature = respond.mock.calls.length
    await act(async () => {
      release()
      await saving
    })
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith({ requestId: "discarding", allow: true }),
    )
    expect(premature).toBe(0)
    queryClient.clear()
  })
})
