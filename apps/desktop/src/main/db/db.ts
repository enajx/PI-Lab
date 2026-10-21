import { type PiLabDatabase, runMigrations } from "@pi-lab/local-db"
import dataFormat from "../../../release-data-format.json"
import { resolveBundledMigrationsDir } from "./migrationsDir"

/**
 * Migration state captured once at boot. Kept module-local so any router can
 * read "is the DB migrated, and to what version" without re-opening the file.
 */
export interface DbStatus {
  /** Number of migrations Drizzle considers applied. */
  appliedCount: number
  /** Compatibility status, always false: unknown migration journals now stop startup. */
  recovered: boolean
  /** Newest migration tag (e.g. "0001_branch_workspace_unique"), or null. */
  latestTag: string | null
  /** Ordered migrations applied to shared data, for safe public channel switches. */
  compatibility: {
    formatVersion: number
    migrations: Array<{ hash: string; createdAt: number }>
  }
}

let status: DbStatus | null = null
let dbHandle: PiLabDatabase | null = null

/**
 * Open the local SQLite DB and apply migrations from a recognized journal.
 * Unknown states stop with a backup and visible error. Must run before any router that
 * touches the DB. Idempotent; the resolved path honors `PI_LAB_DATA_DIR`.
 */
export function initDatabase(): DbStatus {
  const migrationsFolder = resolveBundledMigrationsDir()
  // Pass the resolved folder explicitly — the bundled package's own default
  // resolves relative to the build output, which has no migrations.
  const result = runMigrations(undefined, migrationsFolder)
  dbHandle = result.db
  status = {
    appliedCount: result.appliedCount,
    recovered: result.recovered,
    latestTag: result.latestTag,
    compatibility: {
      formatVersion: dataFormat.version,
      migrations: result.history,
    },
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

/**
 * The migrated Drizzle handle opened at boot, shared by every router that
 * touches the local store. Throws if read before {@link initDatabase} so a
 * mis-ordered boot fails loudly rather than opening a second connection.
 */
export function getDb(): PiLabDatabase {
  if (!dbHandle) {
    throw new Error("Database not initialized — call initDatabase() during boot")
  }
  return dbHandle
}
