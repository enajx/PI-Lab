import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runMigrations } from "@pi-lab/local-db"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { describe, expect, test } from "vitest"
import { assessReleaseCompatibility, type DataCompatibility } from "./compatibility"

const current: DataCompatibility = {
  formatVersion: 2,
  migrations: [
    { hash: "first", createdAt: 1 },
    { hash: "preview", createdAt: 2 },
  ],
}

describe("public release data compatibility", () => {
  test("accepts a release whose migration history extends the applied journal", () => {
    expect(
      assessReleaseCompatibility(current, {
        formatVersion: 2,
        migrations: [...current.migrations, { hash: "stable", createdAt: 3 }],
      }),
    ).toBeNull()
  })

  test("waits when Stable lacks a preview migration or has a fork at the same count", () => {
    expect(
      assessReleaseCompatibility(current, {
        formatVersion: 2,
        migrations: [current.migrations[0]],
      }),
    ).toMatch(/migration/i)
    expect(
      assessReleaseCompatibility(current, {
        formatVersion: 2,
        migrations: [current.migrations[0], { hash: "other", createdAt: 2 }],
      }),
    ).toMatch(/migration/i)
  })

  test("waits for a release that understands the preview data format", () => {
    expect(
      assessReleaseCompatibility(current, {
        formatVersion: 1,
        migrations: current.migrations,
      }),
    ).toMatch(/data format/i)
  })

  test("fails closed on missing or invalid compatibility metadata", () => {
    for (const candidate of [
      undefined,
      { formatVersion: 2 },
      { formatVersion: 2, migrations: [{ hash: "first", createdAt: "1" }] },
      { formatVersion: 0, migrations: [] },
    ]) {
      expect(assessReleaseCompatibility(current, candidate)).toMatch(/metadata/i)
    }
  })

  test("uses the real applied SQLite journal when returning from a preview release", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-lab-update-compatibility-"))
    const migrationsFolder = join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "..",
      "packages",
      "local-db",
      "drizzle",
    )
    try {
      const opened = runMigrations(join(directory, "local.db"), migrationsFolder)
      const migrations = readMigrationFiles({ migrationsFolder }).map(({ hash, folderMillis }) => ({
        hash,
        createdAt: folderMillis,
      }))
      expect(opened.appliedCount).toBe(migrations.length)
      const currentData = { formatVersion: 1, migrations }
      expect(
        assessReleaseCompatibility(currentData, {
          formatVersion: 1,
          migrations: migrations.slice(0, -1),
        }),
      ).toMatch(/migration/i)
      expect(assessReleaseCompatibility(currentData, currentData)).toBeNull()
      opened.sqlite.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
