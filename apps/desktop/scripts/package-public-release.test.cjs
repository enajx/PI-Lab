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

test("the real builder writes GitHub update metadata with publishing disabled", async () => {
  const { createRequire } = require("node:module")
  const builderRequire = createRequire(
    require.resolve("electron-builder", { paths: [join(__dirname, "..")] }),
  )
  const { PublishManager, Platform } = builderRequire("app-builder-lib")
  const { CancellationToken } = builderRequire("builder-util-runtime")
  const { PUBLIC_RELEASE_PUBLISH_MODE } = require("./package-public-release.cjs")
  assert.equal(PUBLIC_RELEASE_PUBLISH_MODE, "never")
  const root = mkdtempSync(join(tmpdir(), "pi-lab-offline-release-"))
  let artifactCreated
  const info = {
    cancellationToken: new CancellationToken(),
    config: { publish: { provider: "github", owner: "enajx", repo: "PI-Lab", channel: "beta" } },
    appInfo: { version: "0.1.0-beta.1" },
    onAfterPack: () => {},
    onArtifactCreated: (listener) => {
      artifactCreated = listener
    },
    emitArtifactCreated: (event) => artifactCreated(event),
  }
  const manager = new PublishManager(info, { publish: PUBLIC_RELEASE_PUBLISH_MODE })
  manager.scheduleUpload = async () => {
    throw new Error("Packaging must never upload")
  }
  const platformPackager = {
    info,
    config: info.config,
    appInfo: info.appInfo,
    platform: Platform.MAC,
    platformSpecificBuildOptions: {},
    expandMacro: (value) => value,
    getResource: async () => null,
  }
  try {
    const zip = join(root, "PI-Lab-0.1.0-beta.1-arm64.zip")
    writeFileSync(zip, "fixture archive bytes")
    await artifactCreated({
      file: zip,
      packager: platformPackager,
      target: { name: "zip", outDir: root },
      arch: 3,
      isWriteUpdateInfo: true,
    })
    await manager.awaitTasks()
    assert.equal(manager.isPublish, false)
    const feed = readFileSync(join(root, "beta-mac.yml"), "utf8")
    assert.match(feed, /version: 0.1.0-beta.1/)
    assert.match(feed, /PI-Lab-0.1.0-beta.1-arm64.zip/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("GitHub release discovery retains PI Lab compatibility and resolves versioned ZIPs", async () => {
  const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider")
  const compatibility = { formatVersion: 1, migrations: [{ hash: "test", createdAt: 1 }] }
  const requests = []
  const executor = {
    request: async (options) => {
      requests.push(options.path)
      if (options.path === "/enajx/PI-Lab/releases.atom") {
        return '<feed><entry><title>Beta 2</title><link href="https://github.com/enajx/PI-Lab/releases/tag/v0.1.0-beta.2"/><content>Changes</content></entry></feed>'
      }
      assert.equal(options.path, "/enajx/PI-Lab/releases/download/v0.1.0-beta.2/beta-mac.yml")
      return `version: 0.1.0-beta.2\nfiles:\n  - url: PI-Lab-0.1.0-beta.2-arm64.zip\n    sha512: fixture\npiLabCompatibility: ${JSON.stringify(compatibility)}\n`
    },
  }
  const provider = new GitHubProvider(
    { provider: "github", owner: "enajx", repo: "PI-Lab" },
    {
      allowPrerelease: true,
      channel: "beta",
      currentVersion: "0.1.0-beta.1",
      fullChangelog: false,
    },
    { executor, platform: "darwin", isUseMultipleRangeRequest: false },
  )
  const release = await provider.getLatestVersion()
  assert.deepEqual(release.piLabCompatibility, compatibility)
  assert.equal(
    provider.resolveFiles(release)[0].url.href,
    "https://github.com/enajx/PI-Lab/releases/download/v0.1.0-beta.2/PI-Lab-0.1.0-beta.2-arm64.zip",
  )
  assert.equal(requests.length, 2)
})
