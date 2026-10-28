import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import Database from "better-sqlite3"
import type { PiLabChannel } from "../identity/channel"

export interface AlphaBuildResetOptions {
  channel: PiLabChannel
  isPackaged: boolean
  buildId: string | null
  dataDir: string
  beforeReset?: () => Promise<void>
}

export interface AlphaBuildResetResult {
  reset: boolean
  archivePath: string | null
}

/** A visible startup failure, with the locations retained for recovery. */
export class AlphaBuildResetFailure extends Error {
  readonly dataDir: string

  constructor(dataDir: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      `Alpha database reset stopped. Previous app data is retained in ${dataDir} or its alpha-db-archives folder. Close other Alpha instances and retry. ${detail}`,
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
async function statIfPresent(filename: string) {
  return lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
}

/** Fold committed WAL pages into the database before moving its closed files. */
function checkpointDatabase(dbPath: string): void {
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
 * Start each packaged Alpha build with a fresh app database, archiving prior
 * database and session-owner records. Call after taking the app instance lock
 * and before opening SQLite or recovering background process records.
 */
export async function prepareAlphaDatabase(
  options: AlphaBuildResetOptions,
): Promise<AlphaBuildResetResult> {
  const { channel, isPackaged, buildId, dataDir } = options
  if (channel !== "alpha" || !isPackaged || !buildId) return { reset: false, archivePath: null }
  const markerPath = join(dataDir, "alpha-build.json")
  const saved = await readFile(markerPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  const previous: { buildId?: unknown } | null = saved === null ? null : JSON.parse(saved)
  if (previous !== null && typeof previous.buildId !== "string")
    throw new Error("Alpha build marker is invalid; the database has been left untouched")
  if (previous?.buildId === buildId) return { reset: false, archivePath: null }
  await options.beforeReset?.()

  const filenames = ["local.db", "local.db-wal", "local.db-shm", "agent-processes"]
  const present: string[] = []
  for (const filename of filenames) {
    const stat = await statIfPresent(join(dataDir, filename))
    if (!stat) continue
    if (
      stat.isSymbolicLink() ||
      (filename === "agent-processes" ? !stat.isDirectory() : !stat.isFile())
    )
      throw new Error(`Alpha reset cannot archive an unexpected path: ${join(dataDir, filename)}`)
    present.push(filename)
  }
  if (present.includes("local.db")) checkpointDatabase(join(dataDir, "local.db"))
  await mkdir(dataDir, { recursive: true })
  let archivePath: string | null = null
  if (present.length > 0) {
    const archiveRoot = join(dataDir, "alpha-db-archives")
    const archiveStat = await statIfPresent(archiveRoot)
    if (archiveStat && (!archiveStat.isDirectory() || archiveStat.isSymbolicLink()))
      throw new Error("Alpha archive directory is not a regular directory")
    archivePath = join(archiveRoot, `${Date.now()}-${randomUUID()}`)
    await mkdir(archivePath, { recursive: true })
    await writeFile(
      join(archivePath, "build.json"),
      JSON.stringify({
        previousBuildId: previous?.buildId ?? null,
        nextBuildId: buildId,
      }),
    )
    for (const filename of present) {
      const source = join(dataDir, filename)
      // Closing the checkpoint connection may remove empty WAL/SHM files.
      if (await statIfPresent(source)) await rename(source, join(archivePath, filename))
    }
  }
  const temporaryMarker = `${markerPath}.${randomUUID()}.tmp`
  await writeFile(temporaryMarker, JSON.stringify({ buildId }))
  await rename(temporaryMarker, markerPath)
  return { reset: true, archivePath }
}
