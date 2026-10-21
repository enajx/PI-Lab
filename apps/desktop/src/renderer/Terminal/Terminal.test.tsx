import { fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { PiLabTrpcClient } from "../trpc/client"
import { Terminal } from "./Terminal"

const xtermHarness = vi.hoisted(() => ({
  customKeyHandler: null as ((event: KeyboardEvent) => boolean) | null,
  dataHandler: null as ((data: string) => void) | null,
  writes: [] as string[],
}))

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}))

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}

    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    write(data: string): void {
      xtermHarness.writes.push(data)
    }
    dispose(): void {}

    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      xtermHarness.customKeyHandler = handler
    }

    onData(handler: (data: string) => void): { dispose: () => void } {
      xtermHarness.dataHandler = handler
      return { dispose: () => {} }
    }
  },
}))

class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function macKeyEvent(key: string, modifiers: Partial<KeyboardEventInit>): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  })
}

describe("Terminal macOS custom key integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    xtermHarness.customKeyHandler = null
    xtermHarness.dataHandler = null
    xtermHarness.writes.length = 0
  })

  test("writes a mapped key once and leaves plain Enter to xterm", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel")
    const write = vi.fn(async () => ({ ok: true as const }))
    const client = {
      terminal: {
        onData: { subscribe: () => ({ unsubscribe: () => {} }) },
        write: { mutate: write },
        resize: { mutate: vi.fn(async () => ({ ok: true as const })) },
      },
    } as unknown as PiLabTrpcClient

    render(<Terminal client={client} inputKind="agent" sessionId="agent-session" />)
    await waitFor(() => expect(xtermHarness.customKeyHandler).not.toBeNull())
    await waitFor(() => expect(xtermHarness.dataHandler).not.toBeNull())

    const shiftedEnter = macKeyEvent("Enter", { shiftKey: true })
    const customHandled = xtermHarness.customKeyHandler?.(shiftedEnter)
    if (customHandled !== false) xtermHarness.dataHandler?.("\r")
    expect(customHandled).toBe(false)
    expect(shiftedEnter.defaultPrevented).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenLastCalledWith({
      sessionId: "agent-session",
      data: "\u001b[13;2u",
    })

    const plainEnter = macKeyEvent("Enter", {})
    const xtermHandled = xtermHarness.customKeyHandler?.(plainEnter)
    if (xtermHandled !== false) xtermHarness.dataHandler?.("\r")
    expect(xtermHandled).toBe(true)
    expect(plainEnter.defaultPrevented).toBe(false)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenLastCalledWith({ sessionId: "agent-session", data: "\r" })
  })

  test("shows failed input once until a write succeeds", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
    const write = vi.fn().mockRejectedValue(new Error("daemon offline"))
    const client = {
      terminal: {
        onData: { subscribe: () => ({ unsubscribe: () => {} }) },
        write: { mutate: write },
        resize: { mutate: vi.fn(async () => ({ ok: true as const })) },
      },
    } as unknown as PiLabTrpcClient
    render(<Terminal client={client} inputKind="terminal" sessionId="input-failure" />)
    await waitFor(() => expect(xtermHarness.dataHandler).not.toBeNull())
    xtermHarness.dataHandler?.("a")
    xtermHarness.dataHandler?.("b")
    await waitFor(() => expect(xtermHarness.writes.join("")).toContain("daemon offline"))
    expect(xtermHarness.writes.join("").match(/daemon offline/g)).toHaveLength(1)
    write.mockResolvedValueOnce({ ok: true })
    xtermHarness.dataHandler?.("c")
    await waitFor(() => expect(write).toHaveBeenCalledTimes(3))
    xtermHarness.dataHandler?.("d")
    await waitFor(() =>
      expect(xtermHarness.writes.join("").match(/daemon offline/g)).toHaveLength(2),
    )
  })

  test("shows a subscription failure in the terminal", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
    const errorHandler = { current: null as ((error: Error) => void) | null }
    const client = {
      terminal: {
        onData: {
          subscribe: (_input: unknown, handlers: { onError: (error: Error) => void }) => {
            errorHandler.current = handlers.onError
            return { unsubscribe: () => {} }
          },
        },
        write: { mutate: vi.fn(async () => ({ ok: true as const })) },
        resize: { mutate: vi.fn(async () => ({ ok: true as const })) },
      },
    } as unknown as PiLabTrpcClient

    render(<Terminal client={client} inputKind="terminal" sessionId="agent-session" />)
    await waitFor(() => expect(errorHandler.current).not.toBeNull())
    errorHandler.current?.(new Error("daemon unavailable"))

    expect(xtermHarness.writes.join("")).toContain("daemon unavailable")
  })

  test("inserts a dropped folder path without submitting it", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
    vi.stubGlobal("piLab", {
      platform: "darwin",
      getPathForFile: () => "/tmp/research folder",
    })
    const write = vi.fn(async () => ({ ok: true as const }))
    const client = {
      terminal: {
        onData: { subscribe: () => ({ unsubscribe: () => {} }) },
        write: { mutate: write },
        resize: { mutate: vi.fn(async () => ({ ok: true as const })) },
      },
    } as unknown as PiLabTrpcClient

    const { getByTestId } = render(
      <Terminal client={client} inputKind="terminal" sessionId="folder-session" />,
    )
    await waitFor(() => expect(xtermHarness.dataHandler).not.toBeNull())
    fireEvent.drop(getByTestId("terminal"), {
      dataTransfer: { files: [new File([], "research folder")] },
    })

    expect(write).toHaveBeenCalledExactlyOnceWith({
      sessionId: "folder-session",
      data: "'/tmp/research folder'",
    })
  })
})
