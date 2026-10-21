import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runMigrations } from "@pi-lab/local-db"
import { expect, test } from "vitest"
import { copyRuntimeMigrations } from "./copy-migrations"

test("copies runnable migration history and removes stale build snapshots without changing source", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-migration-copy-"))
  const from = resolve("packages/local-db/drizzle")
  const to = join(root, "drizzle")
  const journalBytes = readFileSync(join(from, "meta/_journal.json"))
  const entries = (JSON.parse(journalBytes.toString()) as { entries: Array<{ tag: string }> })
    .entries
  const sourceSnapshots = readdirSync(join(from, "meta"))
  try {
    mkdirSync(join(to, "meta"), { recursive: true })
    writeFileSync(join(to, "meta/old_snapshot.json"), "stale")
    writeFileSync(join(to, "stale.sql"), "stale")
    copyRuntimeMigrations(from, to)
    expect(readdirSync(join(to, "meta"))).toEqual(["_journal.json"])
    expect(readdirSync(to).sort()).toEqual(
      [...entries.map(({ tag }) => `${tag}.sql`), "meta"].sort(),
    )
    expect(readFileSync(join(to, "meta/_journal.json"))).toEqual(journalBytes)
    const result = runMigrations(join(root, "copy.db"), to)
    expect(result.appliedCount).toBe(entries.length)
    result.sqlite.close()
    expect(readdirSync(join(from, "meta"))).toEqual(sourceSnapshots)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
