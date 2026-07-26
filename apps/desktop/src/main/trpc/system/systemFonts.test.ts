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
    const caller = createCallerFactory(createSystemRouter(detect))({} as AppContext)

    await expect(caller.fonts()).resolves.toEqual({
      families: ["Avenir Next", "Menlo"],
      error: null,
    })
    await caller.fonts()
    expect(detect).toHaveBeenCalledTimes(1)
  })
})
