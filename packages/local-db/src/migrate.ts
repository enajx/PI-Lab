import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import { resolveDbPath, resolveMigrationsDir } from "./paths"
import * as relations from "./relations"
import * as tables from "./tables"

const schema = { ...tables, ...relations }

export type SkipperDatabase = ReturnType<typeof drizzle<typeof schema>>

export interface OpenDatabaseResult {
  /** Drizzle handle bound to the full schema (tables + relations). */
  db: SkipperDatabase
  /** Underlying better-sqlite3 connection (for pragmas / raw access). */
  sqlite: Database.Database
}

/**
 * Open (creating if needed) the local SQLite database and return a Drizzle
 * handle. Honors `SKIPPER_DATA_DIR` via {@link resolveDbPath}. Foreign keys are
 * enabled and WAL is used for concurrent reader/writer safety.
 */
export function openDatabase(dbPath: string = resolveDbPath()): OpenDatabaseResult {
  mkdirSync(dirname(dbPath), { recursive: true })
  const sqlite = new Database(dbPath)
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("foreign_keys = ON")
  const db = drizzle(sqlite, { schema })
  return { db, sqlite }
}

/** Drizzle's migration bookkeeping table. */
const JOURNAL_TABLE = "__drizzle_migrations"

/**
 * Signature of the "the schema already exists but Drizzle's journal disagrees"
 * failure. This happens when the DB was created/migrated by a build whose
 * journal no longer lines up with the on-disk SQL files (e.g. after a
 * re-generate, or a DB seeded out-of-band). Re-running the same `CREATE TABLE`
 * then throws "table X already exists".
 */
function isBaselineDriftError(error: unknown): boolean {
  // Drizzle wraps the underlying SqliteError ("table X already exists") in a
  // DrizzleError whose top-level message only says "Failed to run the query …",
  // so walk the cause chain too.
  let current: unknown = error
  while (current instanceof Error) {
    const message = current.message.toLowerCase()
    if (message.includes("already exists") || message.includes("duplicate column name")) {
      return true
    }
    current = current.cause
  }
  return false
}

/**
 * Read which migration tags Drizzle believes are already applied. Returns an
 * empty set if the journal table doesn't exist yet (a brand-new DB).
 */
function readAppliedHashes(sqlite: Database.Database): Set<string> {
  const exists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(JOURNAL_TABLE)
  if (!exists) return new Set<string>()
  const rows = sqlite.prepare(`SELECT hash FROM ${JOURNAL_TABLE}`).all() as Array<{ hash: string }>
  return new Set(rows.map((r) => r.hash))
}

/** List user tables currently present in the database. */
function listTables(sqlite: Database.Database): Set<string> {
  const rows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

interface JournalEntry {
  tag: string
  when: number
}

/**
 * Read `meta/_journal.json` to learn every migration's `when` watermark. The
 * better-sqlite3 migrator decides what to apply by comparing each migration's
 * `folderMillis` (== `when`) against the newest `created_at` recorded in the
 * `__drizzle_migrations` table; nothing else about the journal table matters to
 * its skip logic.
 */
function readJournal(migrationsFolder: string): JournalEntry[] {
  const raw = readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")
  const parsed = JSON.parse(raw) as { entries?: JournalEntry[] }
  return parsed.entries ?? []
}

/**
 * Recover from journal/state drift without losing data.
 *
 * The migrator failed because our objects already exist but Drizzle's
 * `__drizzle_migrations` bookkeeping is missing or behind. Since the live schema
 * proves these migrations *did* run, we re-seed the bookkeeping table with a
 * watermark equal to the newest migration's `when` value. Drizzle then treats
 * everything up to that watermark as applied and only runs genuinely new
 * migrations on the next pass — the standard "baseline an existing DB" move.
 *
 * This never drops or truncates user data. If a DB is so corrupt it can't even
 * be read, the caller (Electron main) is expected to move the file aside —
 * never `rm` (AGENTS.md §12.2).
 */
function reconcileJournal(
  db: SkipperDatabase,
  sqlite: Database.Database,
  migrationsFolder: string,
): void {
  const present = listTables(sqlite)
  // If our baseline isn't even there the failure wasn't drift; a clean migrate
  // is the right thing (and will surface any genuine error).
  const hasBaseline = present.has("projects") && present.has("workspaces")
  if (!hasBaseline) {
    migrate(db, { migrationsFolder })
    return
  }

  const entries = readJournal(migrationsFolder)
  const watermark = entries.reduce((max, e) => Math.max(max, e.when), 0)

  // Drizzle's own migrate() creates this table if absent; create it ourselves so
  // we can seed it first.
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)`,
  )
  // Record the existing schema as "applied up to the watermark". The hash is
  // informational for the migrator's skip logic (it keys off created_at), so a
  // recovery marker is sufficient.
  sqlite
    .prepare(`INSERT INTO ${JOURNAL_TABLE} (hash, created_at) VALUES (?, ?)`)
    .run("baseline-recovery", watermark)

  // Re-run: every migration at or below the watermark is skipped; net-new ones
  // (if any) apply cleanly.
  migrate(db, { migrationsFolder })
}

export interface RunMigrationsResult {
  db: SkipperDatabase
  sqlite: Database.Database
  /** True when journal-drift recovery was triggered. */
  recovered: boolean
  /** Number of migration tags Drizzle considers applied afterward. */
  appliedCount: number
}

/**
 * Apply all generated migrations to the local DB, self-healing on journal
 * drift. Idempotent: a second call on an up-to-date DB is a no-op.
 *
 * @param dbPath          DB file to migrate (defaults to the resolved data dir).
 * @param migrationsFolder Override the generated-migrations directory (tests).
 */
export function runMigrations(
  dbPath: string = resolveDbPath(),
  migrationsFolder: string = resolveMigrationsDir(),
): RunMigrationsResult {
  const { db, sqlite } = openDatabase(dbPath)
  let recovered = false
  try {
    migrate(db, { migrationsFolder })
  } catch (error) {
    if (!isBaselineDriftError(error)) {
      sqlite.close()
      throw error
    }
    recovered = true
    reconcileJournal(db, sqlite, migrationsFolder)
  }
  const appliedCount = readAppliedHashes(sqlite).size
  return { db, sqlite, recovered, appliedCount }
}
