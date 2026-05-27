import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runMigrations } from "@skipper/local-db"
import { resolveBundledMigrationsDir } from "./migrationsDir"

/**
 * Migration state captured once at boot. Kept module-local so any router can
 * read "is the DB migrated, and to what version" without re-opening the file.
 */
export interface DbStatus {
  /** Number of migrations Drizzle considers applied. */
  appliedCount: number
  /** True when journal-drift self-healing ran on this boot. */
  recovered: boolean
  /** Newest migration tag (e.g. "0001_branch_workspace_unique"), or null. */
  latestTag: string | null
}

let status: DbStatus | null = null

/**
 * Newest migration tag from `meta/_journal.json`. The applied *count* is the
 * machine check; the tag is the human-readable version label for the renderer.
 */
function readLatestTag(migrationsFolder: string): string | null {
  try {
    const raw = readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")
    const parsed = JSON.parse(raw) as { entries?: Array<{ tag: string; when: number }> }
    const entries = parsed.entries ?? []
    if (entries.length === 0) return null
    return entries.reduce((latest, e) => (e.when > latest.when ? e : latest)).tag
  } catch {
    return null
  }
}

/**
 * Open the local SQLite DB and apply all migrations (self-healing on journal
 * drift — handled inside `@skipper/local-db`). Must run before any router that
 * touches the DB. Idempotent; the resolved path honors `SKIPPER_DATA_DIR`.
 */
export function initDatabase(): DbStatus {
  const migrationsFolder = resolveBundledMigrationsDir()
  // Pass the resolved folder explicitly — the bundled package's own default
  // resolves relative to the build output, which has no migrations.
  const result = runMigrations(undefined, migrationsFolder)
  status = {
    appliedCount: result.appliedCount,
    recovered: result.recovered,
    latestTag: readLatestTag(migrationsFolder),
  }
  return status
}

/** Migration state from this boot. Throws if read before {@link initDatabase}. */
export function getDbStatus(): DbStatus {
  if (!status) {
    throw new Error("Database not initialized — call initDatabase() during boot")
  }
  return status
}
