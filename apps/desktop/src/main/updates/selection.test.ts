import { getSettingsOrDefaults, settings } from "@pi-lab/local-db"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, type Harness } from "../trpc/testHarness"
import { initializePublicUpdateChannel } from "./selection"

let harness: Harness

beforeEach(async () => {
  harness = await createHarness([], { git: false, daemon: "lazy" })
})

afterEach(async () => {
  await harness.dispose()
})

/** Exercise first-release initialization against the real migrated SQLite schema. */
describe("initial public update channel", () => {
  test.each([
    "stable",
    "beta",
  ] as const)("a fresh %s installation follows its release channel", (channel) => {
    initializePublicUpdateChannel(harness.db, { channel })
    expect(getSettingsOrDefaults(harness.db).publicUpdateChannel).toBe(channel)
  })

  test.each(["stable", "beta"] as const)("keeps an existing %s preference", (channel) => {
    harness.db.insert(settings).values({ id: 1, publicUpdateChannel: channel, theme: "dark" }).run()
    initializePublicUpdateChannel(harness.db, { channel: channel === "stable" ? "beta" : "stable" })
    expect(getSettingsOrDefaults(harness.db)).toMatchObject({
      publicUpdateChannel: channel,
      theme: "dark",
    })
  })

  test("local packages leave preferences untouched", () => {
    initializePublicUpdateChannel(harness.db, null)
    expect(harness.db.select().from(settings).get()).toBeUndefined()
  })
})
