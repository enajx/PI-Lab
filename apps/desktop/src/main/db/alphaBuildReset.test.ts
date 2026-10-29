import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { afterEach, expect, test } from "vitest"
import {
  AlphaBuildResetFailure,
  alphaArchiveRoot,
  prepareAlphaBuildData,
  readAlphaBuildId,
} from "./alphaBuildReset"

const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const noLiveWork = (): void => {}
const kept = ["SingletonLock", "SingletonSocket", "SingletonCookie", "pty-daemon.sock"]

/** A data dir inside its own temp parent, so the sibling archive root is cleaned up too. */
function emptyDataDir(): string {
  const parent = mkdtempSync(join(tmpdir(), "pi-lab-alpha-reset-"))
  directories.push(parent)
  const dataDir = join(parent, "data")
  mkdirSync(dataDir)
  return dataDir
}

/** Seed real SQLite data whose journal deliberately cannot match an app migration history. */
function fixture(): { dataDir: string; dbPath: string } {
  const dataDir = emptyDataDir()
  const dbPath = join(dataDir, "local.db")
  const sqlite = new Database(dbPath)
  sqlite.exec(
    "CREATE TABLE settings (value TEXT); INSERT INTO settings VALUES ('saved choice'); CREATE TABLE __drizzle_migrations (hash TEXT); INSERT INTO __drizzle_migrations VALUES ('unknown-branch')",
  )
  sqlite.close()
  return { dataDir, dbPath }
}

/** Fill a data dir with the app, Chromium and agent entries a used Alpha profile holds. */
function seedProfile(dataDir: string): void {
  for (const dir of [
    "Local Storage/leveldb",
    "Session Storage",
    "IndexedDB",
    "Cache",
    "latex/cache",
    "template",
    "worktrees/paper-agent",
    "agent-processes",
    "alpha-db-archives/older",
  ])
    mkdirSync(join(dataDir, dir), { recursive: true })
  writeFileSync(join(dataDir, "Local Storage", "leveldb", "000003.log"), "old interface pref")
  writeFileSync(join(dataDir, "latex", "cache", "package"), "cached TeX")
  writeFileSync(join(dataDir, "template", "main.tex"), "edited template")
  writeFileSync(join(dataDir, "worktrees", "paper-agent", ".git"), "gitdir: /repo/.git/worktrees/x")
  writeFileSync(join(dataDir, "agent-processes", "old-session.json"), '{"session":"old"}')
  writeFileSync(join(dataDir, "alpha-db-archives", "older", "local.db"), "older archive")
  writeFileSync(join(dataDir, "app-icon-selection.json"), '{"palette":"viridis"}')
  writeFileSync(join(dataDir, "Preferences"), "{}")
  writeFileSync(join(dataDir, "Cookies"), "cookies")
  writeFileSync(join(dataDir, "local.db.backup-1-uuid"), "backup")
  // Live single-instance lock and daemon socket entries stay where Chromium and the daemon expect them.
  symlinkSync("host-1234", join(dataDir, "SingletonLock"))
  symlinkSync("/tmp/socket-dir/SingletonSocket", join(dataDir, "SingletonSocket"))
  symlinkSync("cookie", join(dataDir, "SingletonCookie"))
  writeFileSync(join(dataDir, "pty-daemon.sock"), "socket stand-in")
}

test("each new packaged Alpha build archives the whole data dir once, outside it", () => {
  const { dataDir, dbPath } = fixture()
  seedProfile(dataDir)
  const outside = join(dataDir, "..", "outside.txt")
  writeFileSync(outside, "link target")
  symlinkSync(outside, join(dataDir, "linked-file"))
  const first = prepareAlphaBuildData({
    channel: "alpha",
    isPackaged: true,
    buildId: "one",
    dataDir,
    keepEntries: kept,
    beforeReset: noLiveWork,
  })
  expect(first.reset).toBe(true)
  const firstArchive = first.archivePath as string
  expect(firstArchive.startsWith(alphaArchiveRoot(dataDir))).toBe(true)
  const archivedData = join(firstArchive, "data")
  expect(readdirSync(dataDir).sort()).toEqual([...kept, "alpha-build.json"].sort())
  expect(readdirSync(archivedData).sort()).toEqual(
    [
      "Cache",
      "Cookies",
      "IndexedDB",
      "Local Storage",
      "Preferences",
      "Session Storage",
      "agent-processes",
      "alpha-db-archives",
      "app-icon-selection.json",
      "latex",
      "linked-file",
      "local.db",
      "local.db.backup-1-uuid",
      "template",
      "worktrees",
    ].sort(),
  )
  const archived = new Database(join(archivedData, "local.db"), { readonly: true })
  expect(archived.prepare("SELECT value FROM settings").pluck().get()).toBe("saved choice")
  archived.close()
  expect(readFileSync(join(archivedData, "Local Storage", "leveldb", "000003.log"), "utf8")).toBe(
    "old interface pref",
  )
  expect(readFileSync(join(archivedData, "latex", "cache", "package"), "utf8")).toBe("cached TeX")
  expect(readFileSync(join(archivedData, "alpha-db-archives", "older", "local.db"), "utf8")).toBe(
    "older archive",
  )
  // A symlinked entry is moved as a link; its target is never followed or moved.
  expect(lstatSync(join(archivedData, "linked-file")).isSymbolicLink()).toBe(true)
  expect(readFileSync(outside, "utf8")).toBe("link target")
  expect(readlinkSync(join(dataDir, "SingletonLock"))).toBe("host-1234")
  expect(JSON.parse(readFileSync(join(firstArchive, "build.json"), "utf8"))).toEqual({
    previousBuildId: null,
    nextBuildId: "one",
  })

  const fresh = new Database(dbPath)
  fresh.exec("CREATE TABLE projects (name TEXT); INSERT INTO projects VALUES ('reopened paper')")
  fresh.close()
  expect(
    prepareAlphaBuildData({
      channel: "alpha",
      isPackaged: true,
      buildId: "one",
      dataDir,
      keepEntries: kept,
      beforeReset: noLiveWork,
    }),
  ).toEqual({ reset: false, archivePath: null })
  const retained = new Database(dbPath, { readonly: true })
  expect(retained.prepare("SELECT name FROM projects").pluck().get()).toBe("reopened paper")
  retained.close()

  const second = prepareAlphaBuildData({
    channel: "alpha",
    isPackaged: true,
    buildId: "two",
    dataDir,
    keepEntries: kept,
    beforeReset: noLiveWork,
  })
  expect(second.reset).toBe(true)
  expect(second.archivePath).not.toBe(first.archivePath)
  expect(readdirSync(alphaArchiveRoot(dataDir))).toHaveLength(2)
  expect(readdirSync(join(second.archivePath as string, "data")).sort()).toEqual(
    ["alpha-build.json", "local.db"].sort(),
  )
})

test("committed WAL data survives in a standalone archived database", () => {
  const { dataDir, dbPath } = fixture()
  const writer = new Database(dbPath)
  writer.pragma("journal_mode = WAL")
  writer.pragma("wal_autocheckpoint = 0")
  writer.exec("INSERT INTO settings VALUES ('committed in WAL')")
  expect(readFileSync(`${dbPath}-wal`).length).toBeGreaterThan(0)
  const result = prepareAlphaBuildData({
    channel: "alpha",
    isPackaged: true,
    buildId: "wal-build",
    dataDir,
    keepEntries: kept,
    beforeReset: noLiveWork,
  })
  writer.close()
  const archived = new Database(join(result.archivePath as string, "data", "local.db"), {
    readonly: true,
  })
  expect(archived.prepare("SELECT value FROM settings").pluck().all()).toEqual([
    "saved choice",
    "committed in WAL",
  ])
  archived.close()
})

test.each([
  { channel: "beta" as const, isPackaged: true, buildId: "new-beta" },
  { channel: "stable" as const, isPackaged: true, buildId: "new-stable" },
  { channel: "alpha" as const, isPackaged: false, buildId: "development" },
  { channel: "alpha" as const, isPackaged: true, buildId: null },
])("leaves $channel packaged=$isPackaged build=$buildId untouched", (identity) => {
  const { dataDir, dbPath } = fixture()
  const before = readFileSync(dbPath)
  expect(
    prepareAlphaBuildData({ ...identity, dataDir, keepEntries: kept, beforeReset: noLiveWork }),
  ).toEqual({ reset: false, archivePath: null })
  expect(readFileSync(dbPath)).toEqual(before)
  expect(readdirSync(dataDir)).toEqual(["local.db"])
  expect(existsSync(alphaArchiveRoot(dataDir))).toBe(false)
})

test("fresh Alpha profile records the build without producing an empty archive", () => {
  const dataDir = emptyDataDir()
  symlinkSync("host-1234", join(dataDir, "SingletonLock"))
  const options = {
    channel: "alpha" as const,
    isPackaged: true,
    buildId: "fresh",
    dataDir,
    keepEntries: kept,
    beforeReset: noLiveWork,
  }
  expect(prepareAlphaBuildData(options)).toEqual({ reset: true, archivePath: null })
  expect(prepareAlphaBuildData(options)).toEqual({ reset: false, archivePath: null })
  expect(existsSync(alphaArchiveRoot(dataDir))).toBe(false)
})

test("invalid SQLite stops without moving anything or writing the new build marker", () => {
  const { dataDir, dbPath } = fixture()
  writeFileSync(dbPath, "not SQLite")
  mkdirSync(join(dataDir, "template"))
  expect(() =>
    prepareAlphaBuildData({
      channel: "alpha",
      isPackaged: true,
      buildId: "broken",
      dataDir,
      keepEntries: kept,
      beforeReset: noLiveWork,
    }),
  ).toThrow()
  expect(readFileSync(dbPath, "utf8")).toBe("not SQLite")
  expect(readdirSync(dataDir).sort()).toEqual(["local.db", "template"])
})

test("a live database transaction blocks reset and leaves the prior data in place", () => {
  const { dataDir, dbPath } = fixture()
  const writer = new Database(dbPath)
  writer.pragma("journal_mode = WAL")
  writer.exec("BEGIN IMMEDIATE; INSERT INTO settings VALUES ('not yet committed')")
  expect(() =>
    prepareAlphaBuildData({
      channel: "alpha",
      isPackaged: true,
      buildId: "busy",
      dataDir,
      keepEntries: kept,
      beforeReset: noLiveWork,
    }),
  ).toThrow()
  writer.exec("ROLLBACK")
  expect(writer.prepare("SELECT value FROM settings").pluck().all()).toEqual(["saved choice"])
  writer.close()
  expect(readdirSync(dataDir)).not.toContain("alpha-build.json")
  expect(existsSync(alphaArchiveRoot(dataDir))).toBe(false)
})

test("an invalid build marker stops before changing prior app state", () => {
  const { dataDir, dbPath } = fixture()
  const before = readFileSync(dbPath)
  writeFileSync(join(dataDir, "alpha-build.json"), '{"unexpected":true}')
  expect(() =>
    prepareAlphaBuildData({
      channel: "alpha",
      isPackaged: true,
      buildId: "new",
      dataDir,
      keepEntries: kept,
      beforeReset: noLiveWork,
    }),
  ).toThrow("marker is invalid")
  expect(readFileSync(dbPath)).toEqual(before)
  expect(existsSync(alphaArchiveRoot(dataDir))).toBe(false)
})

test("a symlinked data dir is refused without following it", () => {
  const { dataDir } = fixture()
  const linkedDataDir = join(dataDir, "..", "linked-data")
  symlinkSync(dataDir, linkedDataDir)
  expect(() =>
    prepareAlphaBuildData({
      channel: "alpha",
      isPackaged: true,
      buildId: "next",
      dataDir: linkedDataDir,
      keepEntries: kept,
      beforeReset: noLiveWork,
    }),
  ).toThrow("not a regular directory")
  expect(readdirSync(dataDir)).toEqual(["local.db"])
  expect(existsSync(alphaArchiveRoot(linkedDataDir))).toBe(false)
})

test("a move that fails midway is reported, keeps moved entries archived and retries next launch", () => {
  const { dataDir } = fixture()
  writeFileSync(join(dataDir, "alpha-build.json"), JSON.stringify({ buildId: "previous" }))
  mkdirSync(join(dataDir, "worktrees", "stuck"), { recursive: true })
  mkdirSync(join(dataDir, "template"))
  // A directory without write permission cannot be moved to a new parent.
  chmodSync(join(dataDir, "worktrees"), 0o500)
  const options = {
    channel: "alpha" as const,
    isPackaged: true,
    buildId: "next",
    dataDir,
    keepEntries: kept,
    beforeReset: noLiveWork,
  }
  expect(() => prepareAlphaBuildData(options)).toThrow()
  chmodSync(join(dataDir, "worktrees"), 0o700)
  const marker = join(dataDir, "alpha-build.json")
  if (existsSync(marker)) expect(JSON.parse(readFileSync(marker, "utf8")).buildId).toBe("previous")
  expect(readdirSync(dataDir)).toContain("worktrees")
  const [firstArchive] = readdirSync(alphaArchiveRoot(dataDir))
  expect(readdirSync(join(alphaArchiveRoot(dataDir), firstArchive as string, "data"))).toContain(
    "template",
  )
  const retry = prepareAlphaBuildData(options)
  expect(retry.reset).toBe(true)
  expect(readdirSync(join(retry.archivePath as string, "data"))).toContain("worktrees")
  expect(readdirSync(dataDir)).toEqual(["alpha-build.json"])
  expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ buildId: "next" })
})

test("reads a packaged build ID and leaves source and legacy packages unmarked", () => {
  const dataDir = emptyDataDir()
  expect(readAlphaBuildId(false, "/unused")).toBeNull()
  writeFileSync(join(dataDir, "package.json"), "{}")
  expect(readAlphaBuildId(true, dataDir)).toBeNull()
  writeFileSync(
    join(dataDir, "package.json"),
    JSON.stringify({ piLabBuildId: "unique-alpha-build" }),
  )
  expect(readAlphaBuildId(true, dataDir)).toBe("unique-alpha-build")
})

test("startup reset failures explain the retained data location and original error", () => {
  const original = new Error("permission denied")
  const failure = new AlphaBuildResetFailure("/isolated/alpha-data", original)
  expect(failure.message).toContain("/isolated/alpha-data")
  expect(failure.message).toContain(alphaArchiveRoot("/isolated/alpha-data"))
  expect(failure.message).toContain("permission denied")
  expect(failure.cause).toBe(original)
})

test("the live-work guard runs before any move, and its failure preserves everything", () => {
  const { dataDir, dbPath } = fixture()
  seedProfile(dataDir)
  const before = readFileSync(dbPath)
  const entriesBefore = readdirSync(dataDir).sort()
  const marker = JSON.stringify({ buildId: "previous" })
  writeFileSync(join(dataDir, "alpha-build.json"), marker)
  const seenByGuard: string[][] = []
  expect(() =>
    prepareAlphaBuildData({
      channel: "alpha",
      isPackaged: true,
      buildId: "next",
      dataDir,
      keepEntries: kept,
      beforeReset: () => {
        seenByGuard.push(readdirSync(dataDir).sort())
        throw new Error("Close live Alpha jobs first")
      },
    }),
  ).toThrow("Close live Alpha jobs first")
  expect(seenByGuard).toEqual([[...entriesBefore, "alpha-build.json"].sort()])
  expect(readFileSync(dbPath)).toEqual(before)
  expect(readFileSync(join(dataDir, "alpha-build.json"), "utf8")).toBe(marker)
  expect(readdirSync(dataDir).sort()).toEqual([...entriesBefore, "alpha-build.json"].sort())
  expect(existsSync(alphaArchiveRoot(dataDir))).toBe(false)
})

test("reopening the same build skips the pre-reset guard", () => {
  const { dataDir } = fixture()
  writeFileSync(join(dataDir, "alpha-build.json"), JSON.stringify({ buildId: "same" }))
  expect(
    prepareAlphaBuildData({
      channel: "alpha",
      isPackaged: true,
      buildId: "same",
      dataDir,
      keepEntries: kept,
      beforeReset: () => {
        throw new Error("must not inspect live jobs")
      },
    }),
  ).toEqual({ reset: false, archivePath: null })
})
