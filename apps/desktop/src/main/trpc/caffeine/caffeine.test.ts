import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, type Harness } from "../testHarness"

let harness: Harness

beforeEach(async () => {
  harness = await createHarness()
})

afterEach(async () => {
  await harness.dispose()
})

describe("caffeine router", () => {
  test("status polling is read-only and does not register activity", async () => {
    expect(await harness.caller.caffeine.status()).toEqual({
      mode: "off",
      scope: "system-only",
      held: false,
    })
    expect(harness.caffeine.terminalActivityCount).toBe(0)
    expect(harness.caffeine.meaningfulTags).toEqual([])
  })

  test("setMode and setScope persist each choice and immediately reconcile", async () => {
    expect(await harness.caller.caffeine.setMode({ mode: "on" })).toEqual({
      mode: "on",
      scope: "system-only",
      held: true,
    })
    expect(await harness.caller.caffeine.setScope({ scope: "system-plus-display" })).toEqual({
      mode: "on",
      scope: "system-plus-display",
      held: true,
    })

    expect((await harness.caller.settings.get()).caffeine).toEqual({
      mode: "on",
      scope: "system-plus-display",
    })
  })

  test("rejects invalid mode and scope inputs at the public boundary", async () => {
    await expect(harness.caller.caffeine.setMode({ mode: "sometimes" as "auto" })).rejects.toThrow()
    await expect(
      harness.caller.caffeine.setScope({ scope: "display-only" as "system-only" }),
    ).rejects.toThrow()
  })
})
