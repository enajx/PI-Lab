import { DEFAULT_EDITOR_SETTINGS } from "@skipper/local-db"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createHarness, type Harness } from "../testHarness"

// Integration tests for the settings router over a real migrated SQLite DB
// (AGENTS.md §14): a `get` against a fresh DB yields the editor defaults, and
// `updateEditor` upserts + merges the singleton row.

let harness: Harness

beforeEach(async () => {
  harness = await createHarness()
})

afterEach(async () => {
  await harness.dispose()
})

describe("settings.get", () => {
  it("returns the editor defaults on a fresh database", async () => {
    const result = await harness.caller.settings.get()
    expect(result.editor).toEqual(DEFAULT_EDITOR_SETTINGS)
  })
})

describe("settings.updateEditor", () => {
  it("upserts the singleton row and returns the merged editor settings", async () => {
    const result = await harness.caller.settings.updateEditor({ vim: true, typeChecker: "pyrefly" })
    expect(result).toEqual({
      autosave: false,
      vim: true,
      typeChecker: "pyrefly",
      formatOnSave: false,
    })

    // The patch persisted and `get` reflects it.
    const after = await harness.caller.settings.get()
    expect(after.editor).toEqual(result)
  })

  it("merges successive patches without clobbering untouched fields", async () => {
    await harness.caller.settings.updateEditor({ autosave: true })
    const merged = await harness.caller.settings.updateEditor({ formatOnSave: true })
    expect(merged).toEqual({
      autosave: true,
      vim: false,
      typeChecker: "ty",
      formatOnSave: true,
    })
  })
})
