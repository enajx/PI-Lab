import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runMigrations } from "./migrate"
import { getSettingsOrDefaults, SETTINGS_ROW_ID } from "./settings"
import { settings } from "./tables"

// The settings helper is read-only and must behave against a freshly-migrated
// DB (no row yet) and against a persisted row. We migrate the *real* schema to a
// throwaway file-backed SQLite DB (the runner opens its own connection).

let dataDir: string
let dbPath: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "skipper-settings-"))
  dbPath = join(dataDir, "local.db")
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe("getSettingsOrDefaults", () => {
  it("returns schema defaults when no settings row exists, without writing one", () => {
    const { db, sqlite } = runMigrations(dbPath)
    try {
      const result = getSettingsOrDefaults(db)
      expect(result.id).toBe(SETTINGS_ROW_ID)
      expect(result.worktreePerAgent).toBe(false)
      expect(result.theme).toBe("system")
      expect(result.confirmOnQuit).toBe(true)
      expect(result.agentPresets).toEqual([])
      expect(result.knownTeams).toEqual([])

      // The read must NOT have persisted a row.
      const row = db.select().from(settings).get()
      expect(row).toBeUndefined()
    } finally {
      sqlite.close()
    }
  })

  it("returns the persisted row when one exists", () => {
    const { db, sqlite } = runMigrations(dbPath)
    try {
      db.insert(settings).values({ id: SETTINGS_ROW_ID, worktreePerAgent: true }).run()
      const result = getSettingsOrDefaults(db)
      expect(result.worktreePerAgent).toBe(true)
    } finally {
      sqlite.close()
    }
  })
})
