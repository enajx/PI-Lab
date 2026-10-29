import { afterEach, describe, expect, test, vi } from "vitest"
import type { CloseTabBridge, CloseTabRequest } from "../../shared/closeTab"
import { installCloseTabResponder, registerCloseTabHandler } from "./closeTab"

/** A fake preload bridge; the real IPC path is covered by the window-shortcuts E2E. */
function fakeBridge() {
  let listener: ((request: CloseTabRequest) => void) | null = null
  const respond = vi.fn()
  const bridge: CloseTabBridge = {
    subscribe: (next) => {
      listener = next
      return () => {
        listener = null
      }
    },
    respond,
  }
  const send = (requestId: string): void => listener?.({ requestId })
  return { bridge, respond, send, subscribed: () => listener !== null }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe("Cmd+W close-tab responder", () => {
  test("answers not handled when no view registered a handler", () => {
    const h = fakeBridge()
    cleanups.push(installCloseTabResponder(h.bridge))
    h.send("one")
    expect(h.respond).toHaveBeenCalledExactlyOnceWith({ requestId: "one", handled: false })
  })

  test("the latest mounted view decides, and unmounting restores the previous one", () => {
    const h = fakeBridge()
    cleanups.push(installCloseTabResponder(h.bridge))
    const first = vi.fn(() => true)
    const second = vi.fn(() => false)
    const removeFirst = registerCloseTabHandler(first)
    cleanups.push(removeFirst)
    const removeSecond = registerCloseTabHandler(second)
    h.send("one")
    expect(second).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
    expect(h.respond).toHaveBeenLastCalledWith({ requestId: "one", handled: false })
    removeSecond()
    h.send("two")
    expect(first).toHaveBeenCalledOnce()
    expect(h.respond).toHaveBeenLastCalledWith({ requestId: "two", handled: true })
    removeFirst()
    h.send("three")
    expect(h.respond).toHaveBeenLastCalledWith({ requestId: "three", handled: false })
  })

  test("uninstalling stops answering", () => {
    const h = fakeBridge()
    const uninstall = installCloseTabResponder(h.bridge)
    uninstall()
    expect(h.subscribed()).toBe(false)
  })
})
