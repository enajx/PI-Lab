const assert = require("node:assert/strict")
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs")
const { test } = require("node:test")
const { tmpdir } = require("node:os")
const { join } = require("node:path")
const { readMigrationFiles } = require("drizzle-orm/migrator")
const { parseUpdateInfo } = require("electron-updater/out/providers/Provider")
const {
  fanOutUpdateMetadata,
  publicReleaseDestination,
  writeCompatibilityMetadata,
} = require("./package-public-release.cjs")

test("public build destinations are isolated by channel and version", () => {
  const root = "/tmp/pi-lab-public-releases"
  assert.equal(publicReleaseDestination(root, "stable", "1.0.0"), join(root, "stable", "1.0.0"))
  assert.equal(
    publicReleaseDestination(root, "beta", "1.1.0-beta.1"),
    join(root, "beta", "1.1.0-beta.1"),
  )
})

test("a single generated mac feed serves each less stable update track", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-public-feeds-"))
  try {
    const source = "version: 1.0.0\nfiles:\n  - url: PI Lab.zip\n  - url: PI Lab.dmg\n"
    writeFileSync(join(root, "latest-mac.yml"), source)
    fanOutUpdateMetadata(root, "latest")
    assert.equal(readFileSync(join(root, "beta-mac.yml"), "utf8"), source)
    assert.throws(() => readFileSync(join(root, "alpha-mac.yml"), "utf8"), /ENOENT/)

    rmSync(join(root, "latest-mac.yml"))
    writeFileSync(join(root, "beta-mac.yml"), source)
    fanOutUpdateMetadata(root, "beta")
    assert.throws(() => readFileSync(join(root, "alpha-mac.yml"), "utf8"), /ENOENT/)

    rmSync(join(root, "beta-mac.yml"))
    assert.throws(() => fanOutUpdateMetadata(root, "alpha"), /Unknown updater channel/)
    assert.throws(() => fanOutUpdateMetadata(root, "latest"), /latest-mac.yml/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("public feed records the data formats its packaged app can read", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-lab-compatible-feed-"))
  try {
    writeFileSync(join(root, "latest-mac.yml"), "version: 1.0.0\nfiles: []\n")
    writeCompatibilityMetadata(root, "latest")
    const feed = readFileSync(join(root, "latest-mac.yml"), "utf8")
    const metadata = /^piLabCompatibility: (.+)$/m.exec(feed)
    assert.ok(metadata)
    const migrations = readMigrationFiles({
      migrationsFolder: join(__dirname, "..", "..", "..", "packages", "local-db", "drizzle"),
    })
    assert.deepEqual(JSON.parse(metadata[1]), {
      formatVersion: 1,
      migrations: migrations.map(({ hash, folderMillis }) => ({ hash, createdAt: folderMillis })),
    })
    const updaterInfo = parseUpdateInfo(
      feed,
      "latest-mac.yml",
      new URL("https://updates.example.test/latest-mac.yml"),
    )
    assert.deepEqual(updaterInfo.piLabCompatibility, JSON.parse(metadata[1]))
    assert.throws(() => writeCompatibilityMetadata(root, "latest"), /already contains/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
