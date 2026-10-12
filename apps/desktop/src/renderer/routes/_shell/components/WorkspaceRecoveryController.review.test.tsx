import { QueryClient } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { ShutdownRequest } from "../../../../shared/shutdown"
import { withFileOperation } from "../../../Editor/hooks/useEditorBuffers/fileOperations"
import { AppProviders } from "../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../test/fakeTrpcClient"
import { WorkspaceRecoveryStore } from "../projects/-workspaceRecovery"
import { WorkspaceRecoveryController } from "./WorkspaceRecoveryController"

let store: WorkspaceRecoveryStore
vi.mock("../projects/-workspaceState", () => ({ workspaceRecovery: () => store }))
vi.mock("./NewFileController", () => ({ useNewFileController: () => ({ chooseNewFile: vi.fn() }) }))

beforeEach(() => {
  window.localStorage.clear()
  store = new WorkspaceRecoveryStore(window.localStorage)
})
afterEach(() => {
  cleanup()
  store.dispose()
  delete window.piLab
})

describe("normal close with existing editor writes and mocked shutdown IPC", () => {
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
