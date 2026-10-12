import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MigrationFailure, runMigrations } from "./migrate"
import { resolveMigrationsDir } from "./paths"
import { getSettingsOrDefaults } from "./settings"
import { DEFAULT_CAFFEINE_SETTINGS, DEFAULT_NOTIFICATION_SETTINGS, settings } from "./tables"

// Apply the *real* generated migrations to a throwaway file-backed SQLite DB
// (file, not :memory:, because the runner opens its own connection — AGENTS.md
// md/engineering/testing-and-build.md). Each test gets a fresh temp data dir.

let dataDir: string
let dbPath: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "pi-lab-localdb-"))
  dbPath = join(dataDir, "local.db")
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function tableNames(dbFile: string): Set<string> {
  const sqlite = new Database(dbFile)
  try {
    const rows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
    return new Set(rows.map((r) => r.name))
  } finally {
    sqlite.close()
  }
}

function columnNames(dbFile: string, table: string): Set<string> {
  const sqlite = new Database(dbFile)
  try {
    const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string
    }>
    return new Set(rows.map((r) => r.name))
  } finally {
    sqlite.close()
  }
}

describe("runMigrations", () => {
  it("creates every kept table", () => {
    const { sqlite } = runMigrations(dbPath)
    sqlite.close()

    const tables = tableNames(dbPath)
    const kept = [
      "projects",
      "worktrees",
      "workspaces",
      "workspace_sections",
      "settings",
      "agent_settings",
      "agent_credentials",
      "browser_history",
      "machines",
      "automations",
      "automation_runs",
      "agent_sessions",
      "automation_prompt_versions",
    ]
    for (const t of kept) {
      expect(tables, `expected table "${t}"`).toContain(t)
    }
  })

  it("does not create any dropped cloud/identity table", () => {
    const { sqlite } = runMigrations(dbPath)
    sqlite.close()

    const tables = tableNames(dbPath)
    const dropped = [
      "users",
      "organizations",
      "organization_members",
      "tasks",
      "coffee_machine_focus_notes",
      "coffee_machine_sessions",
      "v1_migration_state",
    ]
    for (const t of dropped) {
      expect(tables, `dropped concept "${t}" must be absent`).not.toContain(t)
    }
  })

  it("has the expected columns on core tables", () => {
    const { sqlite } = runMigrations(dbPath)
    sqlite.close()

    const projectCols = columnNames(dbPath, "projects")
    for (const c of [
      "id",
      "repo_path",
      "name",
      "default_branch",
      "color",
      "sort_index",
      "archived_at",
      "last_opened_at",
      "agent_config",
    ]) {
      expect(projectCols, `projects.${c}`).toContain(c)
    }

    const workspaceCols = columnNames(dbPath, "workspaces")
    for (const c of [
      "id",
      "project_id",
      "worktree_id",
      "section_id",
      "kind",
      "name",
      "branch",
      "port_base",
      "python_environment_path",
      "last_active_at",
    ]) {
      expect(workspaceCols, `workspaces.${c}`).toContain(c)
    }

    const settingsCols = columnNames(dbPath, "settings")
    for (const c of [
      "id",
      "theme",
      "agent_presets",
      "confirm_on_quit",
      "known_teams",
      "worktree_per_agent",
      "notifications",
      "caffeine",
    ]) {
      expect(settingsCols, `settings.${c}`).toContain(c)
    }

    const agentSettingsCols = columnNames(dbPath, "agent_settings")
    for (const c of [
      "id",
      "project_config_storage",
      "executable_overrides",
      "setup_completed",
      "updated_at",
    ]) {
      expect(agentSettingsCols, `agent_settings.${c}`).toContain(c)
    }

    const automationCols = columnNames(dbPath, "automations")
    expect(automationCols).toContain("execution_mode")

    // No cloud-identity columns leaked onto kept tables.
    expect(projectCols).not.toContain("neon_project_id")
    expect(settingsCols).not.toContain("active_organization_id")
    expect(settingsCols).not.toContain("expose_host_service_via_relay")

    const automationRunCols = columnNames(dbPath, "automation_runs")
    expect(automationRunCols).toContain("session_id")
    expect(automationRunCols).toContain("completed_at")

    const agentSessionCols = columnNames(dbPath, "agent_sessions")
    for (const c of [
      "id",
      "session_id",
      "project_id",
      "workspace_id",
      "agent_id",
      "workflow_run_id",
      "state",
      "waiting_reason",
      "waiting_since",
      "exited_at",
    ]) {
      expect(agentSessionCols, `agent_sessions.${c}`).toContain(c)
    }
  })

  it("creates the partial unique index for branch workspaces", () => {
    const { sqlite } = runMigrations(dbPath)
    try {
      const idx = sqlite
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("ux_one_branch_workspace_per_project") as { name: string; sql: string } | undefined
      expect(idx).toBeDefined()
      expect(idx?.sql.toLowerCase()).toContain("where")
      expect(idx?.sql.toLowerCase()).toContain("kind")
    } finally {
      sqlite.close()
    }
  })

  it("is idempotent — running twice is a no-op, not an error", () => {
    const first = runMigrations(dbPath)
    const firstCount = first.appliedCount
    first.sqlite.close()
    expect(firstCount).toBeGreaterThan(0)
    expect(first.recovered).toBe(false)

    const second = runMigrations(dbPath)
    try {
      expect(second.appliedCount).toBe(firstCount)
      expect(second.recovered).toBe(false)
    } finally {
      second.sqlite.close()
    }
  })

  it("upgrades a persisted pre-notifications settings row without losing it", () => {
    const legacyMigrations = join(dataDir, "legacy-migrations")
    cpSync(resolveMigrationsDir(), legacyMigrations, { recursive: true })
    rmSync(join(legacyMigrations, "0008_faulty_kingpin.sql"))
    rmSync(join(legacyMigrations, "meta", "0008_snapshot.json"))
    const journalPath = join(legacyMigrations, "meta", "_journal.json")
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<{ idx: number }>
    }
    journal.entries = journal.entries.filter(({ idx }) => idx < 8)
    writeFileSync(journalPath, JSON.stringify(journal, null, 2))

    const legacy = runMigrations(dbPath, legacyMigrations)
    legacy.sqlite
      .prepare("INSERT INTO settings (id, theme, updated_at) VALUES (1, 'dark', 1234)")
      .run()
    legacy.sqlite.close()

    const upgraded = runMigrations(dbPath)
    try {
      const stored = getSettingsOrDefaults(upgraded.db)
      expect(stored.theme).toBe("dark")
      expect(stored.notifications).toEqual(DEFAULT_NOTIFICATION_SETTINGS)
    } finally {
      upgraded.sqlite.close()
    }
  })

  it("upgrades a persisted pre-caffeine settings row without losing it", () => {
    const legacyMigrations = join(dataDir, "legacy-migrations")
    cpSync(resolveMigrationsDir(), legacyMigrations, { recursive: true })
    const journalPath = join(legacyMigrations, "meta", "_journal.json")
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<{ idx: number; tag: string }>
    }
    const newest = journal.entries.at(-1)
    if (!newest) throw new Error("Expected at least one generated migration")
    rmSync(join(legacyMigrations, `${newest.tag}.sql`))
    rmSync(join(legacyMigrations, "meta", `${String(newest.idx).padStart(4, "0")}_snapshot.json`))
    journal.entries = journal.entries.filter(({ idx }) => idx < newest.idx)
    writeFileSync(journalPath, JSON.stringify(journal, null, 2))

    const legacy = runMigrations(dbPath, legacyMigrations)
    legacy.sqlite
      .prepare(
        "INSERT INTO settings (id, theme, notifications, updated_at) VALUES (1, 'light', ?, 5678)",
      )
      .run(JSON.stringify({ ...DEFAULT_NOTIFICATION_SETTINGS, muted: true }))
    legacy.sqlite.close()

    const upgraded = runMigrations(dbPath)
    try {
      const stored = upgraded.db.select().from(settings).get()
      expect(stored?.theme).toBe("light")
      expect(stored?.notifications.muted).toBe(true)
      expect(stored?.caffeine).toEqual(DEFAULT_CAFFEINE_SETTINGS)
    } finally {
      upgraded.sqlite.close()
    }
  })

  it.each(["current", "older"])("stops safely with a missing journal on a %s schema", (version) => {
    const migrations = join(dataDir, "fixture-migrations")
    cpSync(resolveMigrationsDir(), migrations, { recursive: true })
    if (version === "older") {
      const path = join(migrations, "meta", "_journal.json")
      const journal = JSON.parse(readFileSync(path, "utf8"))
      journal.entries.pop()
      writeFileSync(path, JSON.stringify(journal))
    }
    const first = runMigrations(dbPath, migrations)
    first.sqlite.exec("DROP TABLE __drizzle_migrations")
    first.sqlite
      .prepare("INSERT INTO settings (id, theme, updated_at) VALUES (1, 'dark', 1234)")
      .run()
    // Keep the writer open with WAL data not checkpointed: a raw file copy loses it.
    let failure: unknown
    try {
      runMigrations(dbPath)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("backup")
    const backupName = readdirSync(dataDir).find((name) => name.startsWith("local.db.backup-"))
    expect(backupName).toBeDefined()
    const backup = new Database(join(dataDir, backupName as string))
    expect(backup.prepare("SELECT theme FROM settings").get()).toEqual({ theme: "dark" })
    expect(backup.pragma("integrity_check", { simple: true })).toBe("ok")
    backup.close()
    expect(
      first.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE name='__drizzle_migrations'")
        .get(),
    ).toBeUndefined()
    first.sqlite.close()
    expect(columnNames(dbPath, "projects").has("digital_rain")).toBe(version === "current")
  })

  it("rejects an unrecognized journal watermark without trusting it", () => {
    const first = runMigrations(dbPath)
    first.sqlite
      .prepare(
        "UPDATE __drizzle_migrations SET hash = 'baseline-recovery' WHERE rowid = (SELECT MAX(rowid) FROM __drizzle_migrations)",
      )
      .run()
    first.sqlite.close()
    expect(() => runMigrations(dbPath)).toThrow(/journal/i)
  })

  it("rejects missing schema effects even when the complete journal is present", () => {
    const first = runMigrations(dbPath)
    first.sqlite.exec("ALTER TABLE projects DROP COLUMN digital_rain")
    first.sqlite.close()
    expect(() => runMigrations(dbPath)).toThrow(/schema/i)
    expect(columnNames(dbPath, "projects")).not.toContain("digital_rain")
  })

  it("reports an unreadable database without replacing its bytes", () => {
    const original = "not a SQLite database".repeat(100)
    writeFileSync(dbPath, original)
    expect(() => runMigrations(dbPath)).toThrow(MigrationFailure)
    expect(readFileSync(dbPath, "utf8")).toBe(original)
  })

  it("reports backup creation failure and preserves the original database", () => {
    const first = runMigrations(dbPath)
    first.sqlite.exec("DROP TABLE __drizzle_migrations")
    chmodSync(dataDir, 0o500)
    try {
      expect(() => runMigrations(dbPath)).toThrow(/backup could not be created/)
      expect(
        first.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='projects'").get(),
      ).toEqual({ name: "projects" })
    } finally {
      chmodSync(dataDir, 0o700)
      first.sqlite.close()
    }
  })

  it("does not advance the journal after a migration transaction rolls back", () => {
    const migrations = join(dataDir, "failing-migrations")
    cpSync(resolveMigrationsDir(), migrations, { recursive: true })
    const journalPath = join(migrations, "meta", "_journal.json")
    const journal = JSON.parse(readFileSync(journalPath, "utf8"))
    const last = journal.entries.at(-1)
    journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag: "0019_failure" })
    writeFileSync(journalPath, JSON.stringify(journal))
    writeFileSync(
      join(migrations, "0019_failure.sql"),
      "CREATE TABLE rollback_probe (id INTEGER);--> statement-breakpoint\nCREATE TABLE projects (id TEXT);",
    )
    const first = runMigrations(dbPath)
    const count = first.appliedCount
    first.sqlite.close()
    expect(() => runMigrations(dbPath, migrations)).toThrow(/backup/i)
    const raw = new Database(dbPath)
    expect(raw.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get()).toEqual({
      n: count,
    })
    expect(
      raw.prepare("SELECT name FROM sqlite_master WHERE name='rollback_probe'").get(),
    ).toBeUndefined()
    raw.close()
  })

  it("stops on an inconsistent partial schema and leaves its rows available", () => {
    const raw = new Database(dbPath)
    raw.exec(
      "CREATE TABLE projects (id TEXT); CREATE TABLE workspaces (id TEXT); INSERT INTO projects VALUES ('keep-me');",
    )
    raw.close()
    expect(() => runMigrations(dbPath)).toThrow(/backup/i)
    const check = new Database(dbPath)
    expect(check.prepare("SELECT * FROM projects").all()).toEqual([{ id: "keep-me" }])
    expect(
      check.prepare("SELECT name FROM sqlite_master WHERE name='__drizzle_migrations'").get(),
    ).toBeUndefined()
    check.close()
  })
})
