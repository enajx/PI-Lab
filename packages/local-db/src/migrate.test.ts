import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runMigrations } from "./migrate"

// Apply the *real* generated migrations to a throwaway file-backed SQLite DB
// (file, not :memory:, because the runner opens its own connection — AGENTS.md
// §14). Each test gets a fresh temp data dir.

let dataDir: string
let dbPath: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "skipper-localdb-"))
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
      "browser_history",
      "automations",
      "automation_runs",
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
      "last_active_at",
    ]) {
      expect(workspaceCols, `workspaces.${c}`).toContain(c)
    }

    const settingsCols = columnNames(dbPath, "settings")
    for (const c of ["id", "theme", "agent_presets", "confirm_on_quit", "known_teams"]) {
      expect(settingsCols, `settings.${c}`).toContain(c)
    }

    // No cloud-identity columns leaked onto kept tables.
    expect(projectCols).not.toContain("neon_project_id")
    expect(settingsCols).not.toContain("active_organization_id")
    expect(settingsCols).not.toContain("expose_host_service_via_relay")
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

  it("self-heals when the journal is wiped but the schema already exists", () => {
    // First run lays down the full schema + journal.
    const first = runMigrations(dbPath)
    first.sqlite.close()

    // Simulate journal/state drift: drop Drizzle's bookkeeping table while the
    // real tables stay. A naive migrate would now re-run 0000 and explode on
    // "table projects already exists".
    const raw = new Database(dbPath)
    raw.exec("DROP TABLE __drizzle_migrations")
    raw.close()

    const healed = runMigrations(dbPath)
    try {
      expect(healed.recovered).toBe(true)
      // Recovery preserves data: the kept tables are still present.
      const tables = tableNames(dbPath)
      expect(tables).toContain("projects")
      expect(tables).toContain("workspaces")
    } finally {
      healed.sqlite.close()
    }
  })
})
