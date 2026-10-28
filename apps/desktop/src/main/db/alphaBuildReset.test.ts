import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { afterEach, expect, test } from "vitest"
import { AlphaBuildResetFailure, prepareAlphaDatabase, readAlphaBuildId } from "./alphaBuildReset"

const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Seed real SQLite data whose journal deliberately cannot match an app migration history. */
function fixture(): { dataDir: string; dbPath: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-lab-alpha-reset-"))
  directories.push(dataDir)
  const dbPath = join(dataDir, "local.db")
  const sqlite = new Database(dbPath)
  sqlite.exec(
    "CREATE TABLE settings (value TEXT); INSERT INTO settings VALUES ('saved choice'); CREATE TABLE __drizzle_migrations (hash TEXT); INSERT INTO __drizzle_migrations VALUES ('unknown-branch')",
  )
  sqlite.close()
  return { dataDir, dbPath }
}

test("each new packaged Alpha build archives its database once and preserves unrelated files", async () => {
  const { dataDir, dbPath } = fixture()
  mkdirSync(join(dataDir, "latex", "cache"), { recursive: true })
  writeFileSync(join(dataDir, "latex", "cache", "package"), "cached TeX")
  writeFileSync(join(dataDir, "project.tex"), "user source")
  mkdirSync(join(dataDir, "agent-processes"))
  writeFileSync(join(dataDir, "agent-processes", "old-session.json"), '{"session":"old"}')
  const first = await prepareAlphaDatabase({
    channel: "alpha",
    isPackaged: true,
    buildId: "one",
    dataDir,
  })
  expect(first.reset).toBe(true)
  expect(first.archivePath).not.toBeNull()
  const archived = new Database(join(first.archivePath as string, "local.db"), { readonly: true })
  expect(archived.prepare("SELECT value FROM settings").pluck().get()).toBe("saved choice")
  archived.close()
  expect(
    readFileSync(join(first.archivePath as string, "agent-processes", "old-session.json"), "utf8"),
  ).toBe('{"session":"old"}')
  expect(readdirSync(dataDir)).not.toContain("agent-processes")
  const fresh = new Database(dbPath)
  fresh.exec("CREATE TABLE projects (name TEXT); INSERT INTO projects VALUES ('reopened paper')")
  fresh.close()
  expect(
    await prepareAlphaDatabase({ channel: "alpha", isPackaged: true, buildId: "one", dataDir }),
  ).toEqual({ reset: false, archivePath: null })
  const retained = new Database(dbPath, { readonly: true })
  expect(retained.prepare("SELECT name FROM projects").pluck().get()).toBe("reopened paper")
  retained.close()
  const second = await prepareAlphaDatabase({
    channel: "alpha",
    isPackaged: true,
    buildId: "two",
    dataDir,
  })
  expect(second.reset).toBe(true)
  expect(second.archivePath).not.toBe(first.archivePath)
  expect(readdirSync(join(dataDir, "alpha-db-archives"))).toHaveLength(2)
  expect(readFileSync(join(dataDir, "project.tex"), "utf8")).toBe("user source")
  expect(readFileSync(join(dataDir, "latex", "cache", "package"), "utf8")).toBe("cached TeX")
})

test("committed WAL data survives in a standalone archived database", async () => {
  const { dataDir, dbPath } = fixture()
  const writer = new Database(dbPath)
  writer.pragma("journal_mode = WAL")
  writer.pragma("wal_autocheckpoint = 0")
  writer.exec("INSERT INTO settings VALUES ('committed in WAL')")
  expect(readFileSync(`${dbPath}-wal`).length).toBeGreaterThan(0)
  const result = await prepareAlphaDatabase({
    channel: "alpha",
    isPackaged: true,
    buildId: "wal-build",
    dataDir,
  })
  writer.close()
  const archived = new Database(join(result.archivePath as string, "local.db"), { readonly: true })
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
])("leaves $channel packaged=$isPackaged build=$buildId untouched", async (identity) => {
  const { dataDir, dbPath } = fixture()
  const before = readFileSync(dbPath)
  expect(await prepareAlphaDatabase({ ...identity, dataDir })).toEqual({
    reset: false,
    archivePath: null,
  })
  expect(readFileSync(dbPath)).toEqual(before)
  expect(readdirSync(dataDir)).toEqual(["local.db"])
})

test("fresh Alpha profile records the build without producing an empty archive", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-lab-alpha-fresh-"))
  directories.push(dataDir)
  expect(
    await prepareAlphaDatabase({ channel: "alpha", isPackaged: true, buildId: "fresh", dataDir }),
  ).toEqual({ reset: true, archivePath: null })
  expect(
    await prepareAlphaDatabase({ channel: "alpha", isPackaged: true, buildId: "fresh", dataDir }),
  ).toEqual({ reset: false, archivePath: null })
})

test("invalid SQLite stops without replacing the database or writing the new build marker", async () => {
  const { dataDir, dbPath } = fixture()
  writeFileSync(dbPath, "not SQLite")
  await expect(
    prepareAlphaDatabase({ channel: "alpha", isPackaged: true, buildId: "broken", dataDir }),
  ).rejects.toThrow()
  expect(readFileSync(dbPath, "utf8")).toBe("not SQLite")
  expect(readdirSync(dataDir)).not.toContain("alpha-build.json")
})

test("a live database transaction blocks reset and leaves the prior database in place", async () => {
  const { dataDir, dbPath } = fixture()
  const writer = new Database(dbPath)
  writer.pragma("journal_mode = WAL")
  writer.exec("BEGIN IMMEDIATE; INSERT INTO settings VALUES ('not yet committed')")
  await expect(
    prepareAlphaDatabase({ channel: "alpha", isPackaged: true, buildId: "busy", dataDir }),
  ).rejects.toThrow()
  writer.exec("ROLLBACK")
  expect(writer.prepare("SELECT value FROM settings").pluck().all()).toEqual(["saved choice"])
  writer.close()
  expect(readdirSync(dataDir)).not.toContain("alpha-build.json")
  expect(readdirSync(dataDir)).not.toContain("alpha-db-archives")
})

test("an invalid build marker stops before changing prior app state", async () => {
  const { dataDir, dbPath } = fixture()
  const before = readFileSync(dbPath)
  writeFileSync(join(dataDir, "alpha-build.json"), '{"unexpected":true}')
  await expect(
    prepareAlphaDatabase({ channel: "alpha", isPackaged: true, buildId: "new", dataDir }),
  ).rejects.toThrow("marker is invalid")
  expect(readFileSync(dbPath)).toEqual(before)
  expect(readdirSync(dataDir)).not.toContain("alpha-db-archives")
})

test("reads a packaged build ID and leaves source and legacy packages unmarked", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-lab-build-metadata-"))
  directories.push(dataDir)
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
  expect(failure.message).toContain("alpha-db-archives")
  expect(failure.message).toContain("permission denied")
  expect(failure.cause).toBe(original)
})

test("a failed pre-reset guard preserves database, marker and detached-job records", async () => {
  const { dataDir, dbPath } = fixture()
  const before = readFileSync(dbPath)
  const marker = JSON.stringify({ buildId: "previous" })
  writeFileSync(join(dataDir, "alpha-build.json"), marker)
  mkdirSync(join(dataDir, "agent-processes"))
  writeFileSync(join(dataDir, "agent-processes", "job.json"), "live job")
  await expect(
    prepareAlphaDatabase({
      channel: "alpha",
      isPackaged: true,
      buildId: "next",
      dataDir,
      beforeReset: async () => {
        throw new Error("Close live Alpha jobs first")
      },
    }),
  ).rejects.toThrow("Close live Alpha jobs first")
  expect(readFileSync(dbPath)).toEqual(before)
  expect(readFileSync(join(dataDir, "alpha-build.json"), "utf8")).toBe(marker)
  expect(readFileSync(join(dataDir, "agent-processes", "job.json"), "utf8")).toBe("live job")
  expect(readdirSync(dataDir)).not.toContain("alpha-db-archives")
})

test("reopening the same build skips the pre-reset guard", async () => {
  const { dataDir } = fixture()
  writeFileSync(join(dataDir, "alpha-build.json"), JSON.stringify({ buildId: "same" }))
  expect(
    await prepareAlphaDatabase({
      channel: "alpha",
      isPackaged: true,
      buildId: "same",
      dataDir,
      beforeReset: async () => {
        throw new Error("must not inspect live jobs")
      },
    }),
  ).toEqual({ reset: false, archivePath: null })
})
