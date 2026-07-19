import { describe, expect, test, vi } from "vitest"
import { createAppFocusAdapter, type FocusableWindow } from "./focusAdapter"

function fakeWindow(minimized: boolean): FocusableWindow {
  return {
    isMinimized: () => minimized,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  }
}

describe("createAppFocusAdapter", () => {
  test("creates and boots a window before focusing when the macOS app has none", () => {
    const created = fakeWindow(false)
    const createWindow = vi.fn(() => created)
    const focusApp = vi.fn()
    const adapter = createAppFocusAdapter({
      hasFocusedWindow: () => false,
      getWindows: () => [],
      createWindow,
      focusApp,
    })

    adapter.restoreAndFocus()

    expect(createWindow).toHaveBeenCalledOnce()
    expect(created.show).toHaveBeenCalledOnce()
    expect(focusApp).toHaveBeenCalledOnce()
    expect(created.focus).toHaveBeenCalledOnce()
  })

  test("restores the existing minimized window without creating another", () => {
    const existing = fakeWindow(true)
    const createWindow = vi.fn(() => fakeWindow(false))
    const adapter = createAppFocusAdapter({
      hasFocusedWindow: () => false,
      getWindows: () => [existing],
      createWindow,
      focusApp: vi.fn(),
    })

    adapter.restoreAndFocus()

    expect(existing.restore).toHaveBeenCalledOnce()
    expect(createWindow).not.toHaveBeenCalled()
  })
})
