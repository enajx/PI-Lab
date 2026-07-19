import { render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { PiLabTrpcClient } from "../trpc/client"
import { Terminal } from "./Terminal"

const xtermHarness = vi.hoisted(() => ({
  customKeyHandler: null as ((event: KeyboardEvent) => boolean) | null,
  dataHandler: null as ((data: string) => void) | null,
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
    write(): void {}
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
})
