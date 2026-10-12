import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import { type MigrationMeta, readMigrationFiles } from "drizzle-orm/migrator"
import { resolveDbPath, resolveMigrationsDir } from "./paths"
import * as relations from "./relations"
import * as tables from "./tables"

const schema = { ...tables, ...relations }

export type PiLabDatabase = ReturnType<typeof drizzle<typeof schema>>

export interface OpenDatabaseResult {
  /** Drizzle handle bound to the full schema (tables + relations). */
  db: PiLabDatabase
  /** Underlying better-sqlite3 connection (for pragmas / raw access). */
  sqlite: Database.Database
}

/**
 * Open (creating if needed) the local SQLite database and return a Drizzle
 * handle. Honors `PI_LAB_DATA_DIR` via {@link resolveDbPath}. Foreign keys are
 * enabled and WAL is used for concurrent reader/writer safety.
 */
export function openDatabase(dbPath: string = resolveDbPath()): OpenDatabaseResult {
  mkdirSync(dirname(dbPath), { recursive: true })
  const sqlite = new Database(dbPath)
  try {
    sqlite.pragma("journal_mode = WAL")
    sqlite.pragma("foreign_keys = ON")
    const db = drizzle(sqlite, { schema })
    return { db, sqlite }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

/** Drizzle's migration bookkeeping table. */
const JOURNAL_TABLE = "__drizzle_migrations"

interface AppliedMigration {
  hash: string
  created_at: number
}

/** Require the recorded journal to be an exact prefix of the shipped migrations. */
function verifyJournal(sqlite: Database.Database, expected: MigrationMeta[]): number {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>
  const hasJournal = tables.some(({ name }) => name === JOURNAL_TABLE)
  const applied = hasJournal
    ? (sqlite
        .prepare(`SELECT hash, created_at FROM ${JOURNAL_TABLE} ORDER BY created_at, rowid`)
        .all() as AppliedMigration[])
    : []
  if (applied.length === 0 && tables.some(({ name }) => name !== JOURNAL_TABLE)) {
    throw new Error(
      "Migration journal is missing or empty for an existing database. Automatic baselining is disabled.",
    )
  }
  for (const [index, entry] of applied.entries()) {
    const migration = expected[index]
    if (
      !migration ||
      entry.hash !== migration.hash ||
      entry.created_at !== migration.folderMillis
    ) {
      throw new Error(
        "Migration journal does not match the shipped migration history. Automatic baselining is disabled.",
      )
    }
  }
  return applied.length
}

/** Read the schema without SQLite internals or migration bookkeeping. */
function schemaSignature(sqlite: Database.Database): string {
  return JSON.stringify(
    sqlite
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != ? ORDER BY type, name",
      )
      .all(JOURNAL_TABLE),
  )
}

/** Verify schema effects by replaying only the journaled SQL in a disposable database. */
function verifySchema(sqlite: Database.Database, migrations: MigrationMeta[]): void {
  const reference = new Database(":memory:")
  try {
    reference.pragma("foreign_keys = ON")
    reference.transaction(() => {
      for (const migration of migrations) {
        for (const statement of migration.sql) reference.exec(statement)
      }
    })()
    if (schemaSignature(sqlite) !== schemaSignature(reference)) {
      throw new Error(
        "Database schema does not match its migration journal. No schema repair was attempted.",
      )
    }
  } finally {
    reference.close()
  }
}

/** A startup failure that preserves the database and reports its safe-copy outcome. */
export class MigrationFailure extends Error {
  readonly dbPath: string
  readonly backupPath: string | null

  constructor(dbPath: string, backupPath: string | null, cause: unknown, backupError: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    const backup = backupPath
      ? `A SQLite-consistent backup is available at ${backupPath}.`
      : `A backup could not be created: ${String(backupError)}. Preserve the database and its -wal and -shm files.`
    super(`Database migration stopped. Original database: ${dbPath}. ${backup}\n${reason}`, {
      cause,
    })
    this.name = "MigrationFailure"
    this.dbPath = dbPath
    this.backupPath = backupPath
  }
}

/** Copy the live SQLite snapshot, including committed WAL pages, without replacing it. */
function preserveFailure(
  sqlite: Database.Database,
  dbPath: string,
  cause: unknown,
): MigrationFailure {
  const destination = `${dbPath}.backup-${Date.now()}-${randomUUID()}`
  let backupPath: string | null = null
  let backupError: unknown = null
  try {
    sqlite.prepare("VACUUM main INTO ?").run(destination)
    backupPath = destination
  } catch (error) {
    backupError = error
  } finally {
    sqlite.close()
  }
  return new MigrationFailure(dbPath, backupPath, cause, backupError)
}

export interface RunMigrationsResult {
  db: PiLabDatabase
  sqlite: Database.Database
  /** Kept for the existing status interface; automatic journal recovery is disabled. */
  recovered: boolean
  /** Number of migration tags Drizzle considers applied afterward. */
  appliedCount: number
}

/**
 * Apply generated migrations only from a recognized journal prefix. Unknown
 * states stop with a consistent backup; a failed transaction is never baselined.
 */
export function runMigrations(
  dbPath: string = resolveDbPath(),
  migrationsFolder: string = resolveMigrationsDir(),
): RunMigrationsResult {
  let opened: OpenDatabaseResult
  try {
    opened = openDatabase(dbPath)
  } catch (error) {
    throw new MigrationFailure(
      dbPath,
      null,
      error,
      "the database could not be opened for a consistent copy",
    )
  }
  const { db, sqlite } = opened
  try {
    const migrations = readMigrationFiles({ migrationsFolder })
    const previousCount = verifyJournal(sqlite, migrations)
    verifySchema(sqlite, migrations.slice(0, previousCount))
    migrate(db, { migrationsFolder })
    const appliedCount = verifyJournal(sqlite, migrations)
    verifySchema(sqlite, migrations)
    return { db, sqlite, recovered: false, appliedCount }
  } catch (error) {
    throw preserveFailure(sqlite, dbPath, error)
  }
}
