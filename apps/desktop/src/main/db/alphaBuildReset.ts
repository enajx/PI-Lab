import { randomUUID } from "node:crypto"
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  type Stats,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import type BetterSqlite3 from "better-sqlite3"
import type { PiLabChannel } from "../identity/channel"

export interface AlphaBuildResetOptions {
  channel: PiLabChannel
  isPackaged: boolean
  buildId: string | null
  dataDir: string
  /** Top-level entries left in place, such as the live instance lock and daemon socket. */
  keepEntries: readonly string[]
  /** Throws to stop the reset, for example while prior terminals or jobs are alive. */
  beforeReset: () => void
}

export interface AlphaBuildResetResult {
  reset: boolean
  archivePath: string | null
}

/** Archives sit beside the data dir so a reset leaves the data dir empty. */
export function alphaArchiveRoot(dataDir: string): string {
  return `${dataDir}-archives`
}

/** A visible startup failure, with the locations retained for recovery. */
export class AlphaBuildResetFailure extends Error {
  readonly dataDir: string

  constructor(dataDir: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      `Alpha data reset stopped. Previous app data is retained in ${dataDir} or ${alphaArchiveRoot(dataDir)}. Close other Alpha instances and retry. ${detail}`,
      { cause },
    )
    this.name = "AlphaBuildResetFailure"
    this.dataDir = dataDir
  }
}

/** Source runs and legacy packages do not opt into packaged Alpha resets. */
export function readAlphaBuildId(isPackaged: boolean, appPath: string): string | null {
  if (!isPackaged) return null
  const metadata: { piLabBuildId?: unknown } = JSON.parse(
    readFileSync(join(appPath, "package.json"), "utf8"),
  )
  if (metadata.piLabBuildId === undefined) return null
  if (typeof metadata.piLabBuildId !== "string" || !metadata.piLabBuildId.trim())
    throw new Error("Invalid Alpha build ID in packaged metadata")
  return metadata.piLabBuildId
}

/** Return missing paths without hiding permission or filesystem errors. */
function statIfPresent(filename: string): Stats | null {
  try {
    return lstatSync(filename)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/** Fold committed WAL pages into the database before moving its closed files. */
function checkpointDatabase(dbPath: string): void {
  // Loaded only when a reset archives a database: this module is on the startup
  // path, which must not load the native SQLite module (quick-edit startup).
  const Database: typeof BetterSqlite3 = createRequire(import.meta.url)("better-sqlite3")
  const sqlite = new Database(dbPath, { fileMustExist: true, timeout: 0 })
  try {
    const result = sqlite.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>
    if (result.some(({ busy }) => busy !== 0))
      throw new Error(
        "Alpha database is in use. Close other Alpha instances before starting a new build.",
      )
  } finally {
    sqlite.close()
  }
}

/**
 * Start each packaged Alpha build like a fresh install: move every top-level
 * data dir entry, except `keepEntries`, into `<dataDir>-archives/<id>/data`.
 * Synchronous so it can run after taking the instance lock and before Electron
 * is ready, when Chromium has not yet opened its storage in the data dir.
 * Entries are renamed, never deleted; symlinks move as links and are not
 * followed. The build marker is written last, so a failed move retries on the
 * next launch.
 */
export function prepareAlphaBuildData(options: AlphaBuildResetOptions): AlphaBuildResetResult {
  const { channel, isPackaged, buildId, dataDir } = options
  if (channel !== "alpha" || !isPackaged || !buildId) return { reset: false, archivePath: null }
  const dataStat = statIfPresent(dataDir)
  if (dataStat && (dataStat.isSymbolicLink() || !dataStat.isDirectory()))
    throw new Error(`Alpha data dir is not a regular directory: ${dataDir}`)
  const markerPath = join(dataDir, "alpha-build.json")
  const saved = statIfPresent(markerPath) ? readFileSync(markerPath, "utf8") : null
  const previous: { buildId?: unknown } | null = saved === null ? null : JSON.parse(saved)
  if (previous !== null && typeof previous.buildId !== "string")
    throw new Error("Alpha build marker is invalid; the app data has been left untouched")
  if (previous?.buildId === buildId) return { reset: false, archivePath: null }
  options.beforeReset()

  mkdirSync(dataDir, { recursive: true })
  const kept = new Set(options.keepEntries)
  const present = readdirSync(dataDir)
    .filter((name) => !kept.has(name))
    .sort()
  if (present.includes("local.db")) {
    if (!lstatSync(join(dataDir, "local.db")).isFile())
      throw new Error(`Alpha reset cannot archive an unexpected path: ${join(dataDir, "local.db")}`)
    checkpointDatabase(join(dataDir, "local.db"))
  }
  let archivePath: string | null = null
  if (present.length > 0) {
    const archiveRoot = alphaArchiveRoot(dataDir)
    const archiveStat = statIfPresent(archiveRoot)
    if (archiveStat && (!archiveStat.isDirectory() || archiveStat.isSymbolicLink()))
      throw new Error("Alpha archive directory is not a regular directory")
    archivePath = join(archiveRoot, `${Date.now()}-${randomUUID()}`)
    const archivedData = join(archivePath, "data")
    mkdirSync(archivedData, { recursive: true })
    writeFileSync(
      join(archivePath, "build.json"),
      JSON.stringify({
        previousBuildId: previous?.buildId ?? null,
        nextBuildId: buildId,
      }),
    )
    for (const name of present) {
      const source = join(dataDir, name)
      // Closing the checkpoint connection may remove empty WAL/SHM files.
      // rename fails with EXDEV if the archive root is on another filesystem.
      if (statIfPresent(source)) renameSync(source, join(archivedData, name))
    }
  }
  const temporaryMarker = `${markerPath}.${randomUUID()}.tmp`
  writeFileSync(temporaryMarker, JSON.stringify({ buildId }))
  renameSync(temporaryMarker, markerPath)
  return { reset: true, archivePath }
}
