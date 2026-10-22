import { describe, expect, test, vi } from "vitest"
import type { AppContext } from "../context"
import { createCallerFactory } from "../trpc"
import { createSystemRouter } from "./system"

describe("system.fonts", () => {
  test("exposes the cached platform result through the typed router", async () => {
    const detect = vi.fn().mockResolvedValue({
      families: ["Avenir Next", "Menlo"],
      error: null,
    })
    const caller = createCallerFactory(
      createSystemRouter(
        detect,
        {
          get: async () => ({ enabled: false, available: true }),
          set: async (enabled) => ({ enabled, available: true }),
        },
        {
          get: () => ({ visible: true, available: true }),
          set: (visible) => ({ visible, available: true }),
        },
      ),
    )({} as AppContext)

    await expect(caller.fonts()).resolves.toEqual({
      families: ["Avenir Next", "Menlo"],
      error: null,
    })
    await caller.fonts()
    expect(detect).toHaveBeenCalledTimes(1)
  })
})

describe("system.startAtLogin", () => {
  test("reads the OS state and updates it through a separate native setting", async () => {
    let enabled = false
    const caller = createCallerFactory(
      createSystemRouter(
        async () => ({ families: [], error: null }),
        {
          get: async () => ({ enabled, available: true }),
          set: async (next) => {
            enabled = next
            return { enabled, available: true }
          },
        },
        {
          get: () => ({ visible: true, available: true }),
          set: (visible) => ({ visible, available: true }),
        },
      ),
    )({} as AppContext)
    await expect(caller.startAtLogin()).resolves.toEqual({ enabled: false, available: true })
    await expect(caller.setStartAtLogin({ enabled: true })).resolves.toEqual({
      enabled: true,
      available: true,
    })
    await expect(caller.startAtLogin()).resolves.toEqual({ enabled: true, available: true })
  })
})
