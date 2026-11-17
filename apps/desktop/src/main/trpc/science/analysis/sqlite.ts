import { createRequire } from "node:module"
import { TRPCError } from "@trpc/server"
import type BetterSqlite3 from "better-sqlite3"
import {
  type DataFilePreview,
  type DatasetEntry,
  formatCell,
  MAX_FRAME_ROWS,
  MAX_TABLE_ROWS,
  type MetadataPreview,
} from "./previewShapes"
import { type Frame, frameFromValues, tableFromFrame } from "./tables"

/**
 * SQLite (`.db`, `.sqlite`, `.sqlite3`) previews with better-sqlite3, opened
 * read-only. The preview lists the tables and views (as a `datasets` preview,
 * like HDF5) and shows the chosen one (else the first) as a table of its first
 * {@link MAX_FRAME_ROWS} rows. SQLite reads by page, so only the listed
 * metadata, the row counts and the shown rows are read.
 */

/** Max tables and views listed for one file. */
export const MAX_SQLITE_TABLES = 500

type DatabaseClass = typeof BetterSqlite3

/**
 * better-sqlite3 is a native addon, loaded on first use (as in
 * `db/alphaBuildReset.ts`) so importing this module does not load it. The
 * main and preview worker bundles keep it external (electron-vite
 * `NATIVE_DEPS`), so it is required from `node_modules` at run time.
 */
function loadDatabase(): DatabaseClass {
  return createRequire(import.meta.url)("better-sqlite3") as DatabaseClass
}

/** Preview a SQLite file: its tables and views, and the chosen one (else the first). */
export function previewSqlite(
  abs: string,
  table: string | null,
  meta: (note?: string) => MetadataPreview,
): DataFilePreview {
  const Database = loadDatabase()
  const read = withDatabase(Database, abs, (db) => {
    const { tables, truncated } = listTables(db)
    if (tables.length === 0) return meta("This SQLite file has no tables")
    const selected = table ?? tables[0]?.path ?? ""
    if (!tables.some((entry) => entry.path === selected)) {
      return meta(`No table ${selected} in this file`)
    }
    return {
      type: "datasets",
      datasets: tables,
      truncated,
      selected,
      preview: tableFromFrame(tableFrame(db, selected)),
    } satisfies DataFilePreview
  })
  return read.kind === "ok" ? read.value : meta(`Could not read the SQLite file: ${read.reason}`)
}

/**
 * Read one table or view of a SQLite file as a frame. A file that cannot be
 * read, or a name that is not a table or view in it, is a BAD_REQUEST.
 */
export function readSqliteFrame(abs: string, table: string): Frame {
  const Database = loadDatabase()
  const read = withDatabase(Database, abs, (db) => {
    if (!tableNames(db).includes(table)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `No table ${table} in this file` })
    }
    return tableFrame(db, table)
  })
  if (read.kind === "error") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Could not read the SQLite file: ${read.reason}`,
    })
  }
  return read.value
}

/**
 * Open `abs` read-only, run `body`, and close. A SQLite error (not a
 * database, corrupt, locked) comes back as its message; other errors are thrown.
 */
function withDatabase<T>(
  Database: DatabaseClass,
  abs: string,
  body: (db: BetterSqlite3.Database) => T,
): { kind: "ok"; value: T } | { kind: "error"; reason: string } {
  let db: BetterSqlite3.Database | null = null
  try {
    db = new Database(abs, { readonly: true, fileMustExist: true })
    return { kind: "ok", value: body(db) }
  } catch (error: unknown) {
    // better-sqlite3 throws SqliteError for a file that is not a database.
    if (error instanceof Database.SqliteError) return { kind: "error", reason: error.message }
    throw error
  } finally {
    db?.close()
  }
}

/** User tables and views in file order (SQLite's own `sqlite_*` tables left out). */
const LIST_SQL = `SELECT name, type FROM sqlite_master
  WHERE type IN ('table', 'view') AND substr(name, 1, 7) != 'sqlite_'
  ORDER BY rowid`

function tableNames(db: BetterSqlite3.Database): string[] {
  return (db.prepare(LIST_SQL).all() as Array<{ name: string }>).map((row) => row.name)
}

/** The tables and views with their row and column counts; truncated past {@link MAX_SQLITE_TABLES}. */
function listTables(db: BetterSqlite3.Database): { tables: DatasetEntry[]; truncated: boolean } {
  const rows = db.prepare(`${LIST_SQL} LIMIT ?`).all(MAX_SQLITE_TABLES + 1) as Array<{
    name: string
    type: string
  }>
  const tables = rows.slice(0, MAX_SQLITE_TABLES).map((row) => {
    const name = quoteName(row.name)
    const count = db.prepare(`SELECT count(*) FROM ${name}`).pluck().get() as number
    const columns = db.prepare(`SELECT * FROM ${name}`).columns().length
    return { path: row.name, shape: [count, columns], dtype: row.type }
  })
  return { tables, truncated: rows.length > MAX_SQLITE_TABLES }
}

/** The first {@link MAX_FRAME_ROWS} rows of a table or view, with its total row count. */
function tableFrame(db: BetterSqlite3.Database, table: string): Frame {
  const name = quoteName(table)
  const totalRows = db.prepare(`SELECT count(*) FROM ${name}`).pluck().get() as number
  const select = db.prepare(`SELECT * FROM ${name} LIMIT ?`).raw(true)
  const headers = select.columns().map((column) => column.name)
  const rows = select.all(MAX_FRAME_ROWS) as unknown[][]
  return frameFromValues({
    headers,
    columns: headers.map((_, col) => rows.map((row) => row[col] ?? null)),
    head: rows.slice(0, MAX_TABLE_ROWS).map((row) => row.map(cellText)),
    totalRows,
    indexColumn: null,
    text: cellText,
  })
}

/** A table name as an SQL identifier: in double quotes, with any `"` doubled. */
function quoteName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** One SQLite value as table text; a BLOB shows its size. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "number") return Number.isFinite(value) ? formatCell(value) : String(value)
  if (typeof value === "bigint") return String(value)
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`
  return String(value)
}
