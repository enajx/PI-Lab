import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runMigrations } from "./migrate"
import { resolveMigrationsDir } from "./paths"
import { getAgentSettingsOrDefaults, getSettingsOrDefaults, SETTINGS_ROW_ID } from "./settings"
import {
  agentSettings,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_CAFFEINE_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_PROJECT_TEMPLATE_SETTINGS,
  settings,
} from "./tables"

// The settings helper is read-only and must behave against a freshly-migrated
// DB (no row yet) and against a persisted row. We migrate the *real* schema to a
// throwaway file-backed SQLite DB (the runner opens its own connection).

let dataDir: string
let dbPath: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "pi-lab-settings-"))
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
      expect(result.keepRunningAfterClose).toBe(true)
      expect(result.agentPresets).toEqual([])
      expect(result.knownTeams).toEqual([])
      expect(result.notifications).toEqual(DEFAULT_NOTIFICATION_SETTINGS)
      expect(result.caffeine).toEqual(DEFAULT_CAFFEINE_SETTINGS)
      expect(result.caffeine.mode).toBe("off")
      expect(result.caffeine.scope).toBe("system-only")
      expect(result.projectTemplate.initializationMarkdownFiles).toEqual([])
      expect(result.projectTemplate.projectTypes.map((type) => [type.id, type.name])).toEqual([
        ["research", "Research project"],
        ["software", "Software project"],
        ["manuscript", "Manuscript"],
      ])

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
      expect(result.projectTemplate.initializationMarkdownFiles).toEqual([])
    } finally {
      sqlite.close()
    }
  })

  it("upgrades a saved General/Paper type list while keeping edited Paper guidance", () => {
    const { db, sqlite } = runMigrations(dbPath)
    try {
      db.insert(settings)
        .values({
          id: SETTINGS_ROW_ID,
          projectTemplate: {
            ...DEFAULT_PROJECT_TEMPLATE_SETTINGS,
            projectTypes: [
              { id: "general", name: "General project", guidance: "Old general guidance." },
              { id: "paper", name: "Paper", guidance: "My paper guidance." },
              { id: "my-type", name: "My type", guidance: "My custom guidance." },
            ],
          },
        })
        .run()

      const types = getSettingsOrDefaults(db).projectTemplate.projectTypes
      expect(types.map((type) => type.id)).toEqual(["research", "software", "manuscript"])
      expect(types.find((type) => type.id === "manuscript")?.guidance).toBe("My paper guidance.")
      expect(db.select().from(settings).get()?.projectTemplate.projectTypes.at(-1)?.guidance).toBe(
        "My custom guidance.",
      )
    } finally {
      sqlite.close()
    }
  })

  it("fills notification events added after an older JSON settings row was written", () => {
    const { db, sqlite } = runMigrations(dbPath)
    try {
      sqlite
        .prepare("INSERT INTO settings (id, notifications, updated_at) VALUES (1, ?, 1234)")
        .run(
          JSON.stringify({
            muted: true,
            agentInput: { enabled: false, sound: "silent" },
            workflowStart: { enabled: false, sound: "pulse" },
            workflowCompletion: { enabled: true, sound: "success" },
            workflowFailure: { enabled: true, sound: "alert" },
          }),
        )

      const result = getSettingsOrDefaults(db)
      expect(result.notifications.muted).toBe(true)
      expect(result.notifications.agentInput).toEqual({ enabled: false, sound: "silent" })
      expect(result.notifications.agentTurnCompletion).toEqual(
        DEFAULT_NOTIFICATION_SETTINGS.agentTurnCompletion,
      )
      expect(result.notifications.terminalCompletion).toEqual(
        DEFAULT_NOTIFICATION_SETTINGS.terminalCompletion,
      )
    } finally {
      sqlite.close()
    }
  })

  it("restores persisted caffeine choices after the database is reopened", () => {
    const first = runMigrations(dbPath)
    first.db
      .insert(settings)
      .values({
        id: SETTINGS_ROW_ID,
        caffeine: { mode: "auto", scope: "system-plus-display" },
      })
      .run()
    first.sqlite.close()

    const reopened = runMigrations(dbPath)
    try {
      expect(getSettingsOrDefaults(reopened.db).caffeine).toEqual({
        mode: "auto",
        scope: "system-plus-display",
      })
    } finally {
      reopened.sqlite.close()
    }
  })
})

describe("getAgentSettingsOrDefaults", () => {
  it("returns app-memory, no overrides, and incomplete setup without writing a row", () => {
    const { db, sqlite } = runMigrations(dbPath)
    try {
      expect(getAgentSettingsOrDefaults(db)).toEqual(DEFAULT_AGENT_SETTINGS)
      expect(db.select().from(agentSettings).get()).toBeUndefined()
    } finally {
      sqlite.close()
    }
  })
})

describe("global LaTeX provider migration", () => {
  it("adds bundled to legacy JSON while preserving every saved preference", () => {
    const folder = join(dataDir, "legacy-migrations")
    cpSync(resolveMigrationsDir(), folder, { recursive: true })
    const journalPath = join(folder, "meta", "_journal.json")
    const journal = JSON.parse(readFileSync(journalPath, "utf8"))
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 26)
    writeFileSync(journalPath, JSON.stringify(journal))
    const legacy = runMigrations(dbPath, folder)
    const editor = {
      autosave: true,
      vim: true,
      editorTheme: "custom:my-theme",
      futureKey: "retain",
    }
    legacy.sqlite
      .prepare("INSERT INTO settings (id, theme, editor, updated_at) VALUES (1, 'dark', ?, 1234)")
      .run(JSON.stringify(editor))
    const before = legacy.sqlite.prepare("SELECT * FROM settings").get() as Record<string, unknown>
    legacy.sqlite.close()

    const migrated = runMigrations(dbPath)
    const after = migrated.sqlite.prepare("SELECT * FROM settings").get() as Record<string, unknown>
    expect(JSON.parse(after.editor as string)).toEqual({ ...editor, latexProvider: "bundled" })
    expect({ ...after, editor: before.editor }).toEqual(before)
    expect(getSettingsOrDefaults(migrated.db).editor.latexProvider).toBe("bundled")
    migrated.sqlite.close()
  })
})
