import { fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { PiLabTrpcClient } from "../trpc/client"
import { Terminal } from "./Terminal"

const xtermHarness = vi.hoisted(() => ({
  customKeyHandler: null as ((event: KeyboardEvent) => boolean) | null,
  dataHandler: null as ((data: string) => void) | null,
  writes: [] as string[],
  selectionHandler: null as (() => void) | null,
  scrollHandler: null as (() => void) | null,
  hasSelection: false,
  viewportY: 0,
  baseY: 0,
}))

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 100, rows: 30 }
    }
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
    textarea = document.createElement("textarea")
    element = document.createElement("div")
    write(data: string | Uint8Array, applied?: () => void): void {
      xtermHarness.writes.push(typeof data === "string" ? data : new TextDecoder().decode(data))
      applied?.()
    }
    reset(): void {}
    resize(cols: number, rows: number): void {
      this.cols = cols
      this.rows = rows
    }
    dispose(): void {}

    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      xtermHarness.customKeyHandler = handler
    }

    onData(handler: (data: string) => void): { dispose: () => void } {
      xtermHarness.dataHandler = handler
      return { dispose: () => {} }
    }

    hasSelection(): boolean {
      return xtermHarness.hasSelection
    }

    get buffer() {
      return {
        active: {
          viewportY: xtermHarness.viewportY,
          baseY: xtermHarness.baseY,
          cursorX: 0,
          cursorY: 0,
          type: "normal",
          getLine: () => undefined,
        },
      }
    }

    onWriteParsed(): { dispose: () => void } {
      return { dispose: () => {} }
    }

    onSelectionChange(handler: () => void): { dispose: () => void } {
      xtermHarness.selectionHandler = handler
      return { dispose: () => {} }
    }

    onScroll(handler: () => void): { dispose: () => void } {
      xtermHarness.scrollHandler = handler
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
    xtermHarness.selectionHandler = null
    xtermHarness.scrollHandler = null
    xtermHarness.hasSelection = false
    xtermHarness.viewportY = 0
    xtermHarness.baseY = 0
  })

  test("writes a mapped key once and leaves plain Enter to xterm", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel")
    const write = vi.fn(async () => ({ ok: true as const }))
    const client = {
      terminal: {
        output: { subscribe: () => ({ unsubscribe: () => {} }) },
        write: { mutate: write },
        resize: { mutate: vi.fn(async () => ({ ok: true as const })) },
      },
    } as unknown as PiLabTrpcClient

    render(<Terminal client={client} inputKind="agent" sessionId="agent-session" visible />)
    await waitFor(() => expect(xtermHarness.customKeyHandler).not.toBeNull())
    await waitFor(() => expect(xtermHarness.dataHandler).not.toBeNull())

    const shiftedEnter = macKeyEvent("Enter", { shiftKey: true })
    const customHandled = xtermHarness.customKeyHandler?.(shiftedEnter)
    if (customHandled !== false) xtermHarness.dataHandler?.("\r")
    expect(customHandled).toBe(false)
    expect(shiftedEnter.defaultPrevented).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenLastCalledWith(
      {
        sessionId: "agent-session",
        data: "\u001b[13;2u",
        clientId: expect.any(String),
        key: { seq: expect.any(Number), typedAt: null, firstSend: true },
      },
      { signal: expect.any(AbortSignal) },
    )

    const plainEnter = macKeyEvent("Enter", {})
    const xtermHandled = xtermHarness.customKeyHandler?.(plainEnter)
    if (xtermHandled !== false) xtermHarness.dataHandler?.("\r")
    expect(xtermHandled).toBe(true)
    expect(plainEnter.defaultPrevented).toBe(false)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenLastCalledWith(
      {
        sessionId: "agent-session",
        data: "\r",
        clientId: expect.any(String),
        key: { seq: expect.any(Number), typedAt: null, firstSend: true },
      },
      { signal: expect.any(AbortSignal) },
    )
  })

  test("shows failed input in the banner, never in xterm, until a write succeeds", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
    const write = vi.fn().mockRejectedValue(new Error("daemon offline"))
    const client = {
      terminal: {
        output: { subscribe: () => ({ unsubscribe: () => {} }) },
        write: { mutate: write },
        resize: { mutate: vi.fn(async () => ({ ok: true as const })) },
      },
    } as unknown as PiLabTrpcClient
    const view = render(
      <Terminal client={client} inputKind="terminal" sessionId="input-failure" visible />,
    )
    await waitFor(() => expect(xtermHarness.dataHandler).not.toBeNull())
    xtermHarness.dataHandler?.("a")
    xtermHarness.dataHandler?.("b")
    await waitFor(() =>
      expect(view.getByTestId("terminal-notice").textContent).toContain(
        "Terminal input failed: daemon offline",
      ),
    )
    expect(view.getAllByText(/daemon offline/)).toHaveLength(1)
    write.mockResolvedValueOnce({ ok: true })
    xtermHarness.dataHandler?.("c")
    await waitFor(() => expect(view.queryByTestId("terminal-notice")).toBeNull())
    xtermHarness.dataHandler?.("d")
    await waitFor(() => expect(view.getAllByText(/daemon offline/)).toHaveLength(1))
    expect(xtermHarness.writes.join("")).not.toContain("daemon offline")
  })

  test("shows a subscription failure in the banner, not in xterm", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
    const errorHandler = {
      current: null as ((error: { message: string; data: unknown }) => void) | null,
    }
    const client = {
      terminal: {
        output: {
          subscribe: (
            _input: unknown,
            handlers: { onError: (error: { message: string; data: unknown }) => void },
          ) => {
            errorHandler.current = handlers.onError
            return { unsubscribe: () => {} }
          },
        },
        write: { mutate: vi.fn(async () => ({ ok: true as const })) },
        resize: { mutate: vi.fn(async () => ({ ok: true as const })) },
      },
    } as unknown as PiLabTrpcClient

    const view = render(
      <Terminal client={client} inputKind="terminal" sessionId="agent-session" visible />,
    )
    await waitFor(() => expect(errorHandler.current).not.toBeNull())
    errorHandler.current?.({
      message: "daemon unavailable",
      data: { code: "INTERNAL_SERVER_ERROR" },
    })

    await waitFor(() =>
      expect(view.getByTestId("terminal-notice").textContent).toContain(
        "Terminal connection failed: daemon unavailable",
      ),
    )
    expect(xtermHarness.writes.join("")).not.toContain("daemon unavailable")
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
        output: { subscribe: () => ({ unsubscribe: () => {} }) },
        write: { mutate: write },
        resize: { mutate: vi.fn(async () => ({ ok: true as const })) },
      },
    } as unknown as PiLabTrpcClient

    const { getByTestId } = render(
      <Terminal client={client} inputKind="terminal" sessionId="folder-session" visible />,
    )
    await waitFor(() => expect(xtermHarness.dataHandler).not.toBeNull())
    fireEvent.drop(getByTestId("terminal"), {
      dataTransfer: { files: [new File([], "research folder")] },
    })

    expect(write).toHaveBeenCalledExactlyOnceWith(
      {
        sessionId: "folder-session",
        data: "'/tmp/research folder'",
        clientId: expect.any(String),
        key: { seq: expect.any(Number), typedAt: null, firstSend: true },
      },
      { signal: expect.any(AbortSignal) },
    )
  })

  // Mocked xterm and tRPC client: checks the pane's wiring only. The real
  // resume runs through the server in server/terminalConnection.test.ts and the
  // app in tests/e2e/connection-state.spec.ts.
  test("after a dropped socket the pane subscribes again from what its emulator applied", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
    const inputs: unknown[] = []
    const handlers: {
      onData: (event: { id: string; data: unknown }) => void
      onConnectionStateChange: (state: { state: string; error: unknown }) => void
    }[] = []
    const resize = vi.fn(async () => ({ ok: true as const, applied: true }))
    const client = {
      terminal: {
        output: {
          subscribe: (input: { resume: unknown }, observer: (typeof handlers)[number]) => {
            inputs.push(input.resume)
            handlers.push(observer)
            return { unsubscribe: () => {} }
          },
        },
        ack: { mutate: vi.fn(async () => ({ ok: true as const, known: true })) },
        write: { mutate: vi.fn(async () => ({ ok: true as const })) },
        resize: { mutate: resize },
      },
    } as unknown as PiLabTrpcClient
    render(<Terminal client={client} inputKind="terminal" sessionId="resume-session" visible />)
    await waitFor(() => expect(handlers).toHaveLength(1))
    const first = handlers[0]
    if (!first) throw new Error("no subscription")
    first.onConnectionStateChange({ state: "pending", error: null })
    first.onData({
      id: "g1:5:0",
      data: {
        type: "start",
        input: { echo: true, icanon: true },
        mode: "snapshot",
        generation: "g1",
        revision: 0,
        cols: 80,
        rows: 24,
        offset: 0,
        screen: "",
        base64: btoa("hello"),
      },
    })
    first.onData({ id: "g1:8:0", data: { type: "data", offset: 5, base64: btoa(" ok") } })
    expect(xtermHarness.writes.join("")).toContain("hello ok")
    // Focus took the size: the pane asked for its own size.
    expect(resize).toHaveBeenCalledWith({
      sessionId: "resume-session",
      cols: 100,
      rows: 30,
      clientId: expect.any(String),
    })

    first.onConnectionStateChange({ state: "connecting", error: new Error("WebSocket closed") })
    await waitFor(() => expect(handlers).toHaveLength(2))
    expect(inputs).toEqual([null, { generation: "g1", offset: 8, revision: 0 }])
  })

  // Mocked xterm and tRPC client: checks the pane's wiring only. The real
  // flow control runs through the server in server/terminalConnection.test.ts.
  test("a hidden pane ends its subscription and resumes from its consumed point when shown; a selection or a scrolled-up view holds skips", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
    const inputs: { resume: unknown; streamId: string; holdSkip: boolean }[] = []
    const unsubscribed: number[] = []
    const handlers: {
      onData: (event: { id: string; data: unknown }) => void
      onConnectionStateChange: (state: { state: string; error: unknown }) => void
    }[] = []
    const ack = vi.fn(async () => ({ ok: true as const, known: true }))
    const client = {
      terminal: {
        output: {
          subscribe: (input: (typeof inputs)[number], observer: (typeof handlers)[number]) => {
            const index = inputs.length
            inputs.push(input)
            handlers.push(observer)
            return { unsubscribe: () => unsubscribed.push(index) }
          },
        },
        ack: { mutate: ack },
        write: { mutate: vi.fn(async () => ({ ok: true as const })) },
        resize: { mutate: vi.fn(async () => ({ ok: true as const, applied: true })) },
      },
    } as unknown as PiLabTrpcClient
    const view = render(
      <Terminal client={client} inputKind="terminal" sessionId="hidden-session" visible />,
    )
    await waitFor(() => expect(handlers).toHaveLength(1))
    handlers[0]?.onData({
      id: "g1:5:0",
      data: {
        type: "start",
        input: { echo: true, icanon: true },
        mode: "snapshot",
        generation: "g1",
        revision: 0,
        cols: 80,
        rows: 24,
        offset: 0,
        screen: "",
        base64: btoa("hello"),
      },
    })
    // The applied start is acked on the terminal's stream.
    await waitFor(() =>
      expect(ack).toHaveBeenLastCalledWith({
        streamId: inputs[0]?.streamId,
        offset: 5,
        holdSkip: false,
      }),
    )

    // A selection holds skips; clearing it and being at the bottom releases them.
    xtermHarness.hasSelection = true
    xtermHarness.selectionHandler?.()
    expect(ack).toHaveBeenLastCalledWith({
      streamId: inputs[0]?.streamId,
      offset: 5,
      holdSkip: true,
    })
    xtermHarness.hasSelection = false
    xtermHarness.baseY = 40
    xtermHarness.viewportY = 10
    xtermHarness.scrollHandler?.()
    expect(ack).toHaveBeenCalledTimes(2)
    xtermHarness.viewportY = 40
    xtermHarness.scrollHandler?.()
    expect(ack).toHaveBeenLastCalledWith({
      streamId: inputs[0]?.streamId,
      offset: 5,
      holdSkip: false,
    })

    view.rerender(
      <Terminal client={client} inputKind="terminal" sessionId="hidden-session" visible={false} />,
    )
    expect(unsubscribed).toEqual([0])
    expect(handlers).toHaveLength(1)
    view.rerender(
      <Terminal client={client} inputKind="terminal" sessionId="hidden-session" visible />,
    )
    await waitFor(() => expect(handlers).toHaveLength(2))
    expect(inputs[1]?.resume).toEqual({ generation: "g1", offset: 5, revision: 0 })
    expect(inputs[1]?.streamId).not.toBe(inputs[0]?.streamId)
  })
})
