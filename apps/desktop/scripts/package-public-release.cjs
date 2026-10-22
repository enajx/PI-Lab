// @ts-check
const { randomUUID } = require("node:crypto")
const {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs")
const { join } = require("node:path")
const { readMigrationFiles } = require("drizzle-orm/migrator")
const { acquireBuildLock, runBuildSteps } = require("./package-channel.cjs")
const {
  assertPublicReleaseCredentials,
  publicReleaseDefinition,
  publicUpdateUrl,
} = require("./public-release.cjs")

const PUBLIC_RELEASE_PUBLISH_MODE = "never"

const RELEASE_ROOT = join(__dirname, "..", "release")
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "local-db", "drizzle")

/** A public build never replaces an installed app or a previous release artifact. */
function publicReleaseDestination(root, channel, version) {
  return join(root, channel, version)
}

/** Add the candidate's readable data history to electron-updater's feed. */
function writeCompatibilityMetadata(root, channel) {
  const source = join(root, `${channel}-mac.yml`)
  const feed = readFileSync(source, "utf8")
  if (/^piLabCompatibility:/m.test(feed)) {
    throw new Error(`Public feed already contains data compatibility metadata: ${source}`)
  }
  const format = JSON.parse(readFileSync(join(__dirname, "..", "release-data-format.json"), "utf8"))
  if (!Number.isSafeInteger(format.version) || format.version < 1) {
    throw new Error("Invalid public release data format version")
  }
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR }).map(
    ({ hash, folderMillis }) => ({ hash, createdAt: folderMillis }),
  )
  const compatibility = { formatVersion: format.version, migrations }
  writeFileSync(source, `${feed.trimEnd()}\npiLabCompatibility: ${JSON.stringify(compatibility)}\n`)
}

/** Copy the one generated manifest to tracks that also accept this release. */
function fanOutUpdateMetadata(root, channel) {
  const lowerTracks = {
    latest: ["beta"],
    beta: [],
  }
  const targets = lowerTracks[channel]
  if (!targets) throw new Error(`Unknown updater channel: ${channel}`)
  const source = join(root, `${channel}-mac.yml`)
  if (!lstatSync(source, { throwIfNoEntry: false })) {
    throw new Error(`Public macOS update metadata is missing: ${source}`)
  }
  for (const target of targets) copyFileSync(source, join(root, `${target}-mac.yml`))
}

/** Generate signed release artifacts and feed files locally, without uploading. */
function packagePublicRelease(channel, version) {
  if (process.platform !== "darwin") throw new Error("Public releases currently support macOS only")
  const release = publicReleaseDefinition(channel, version)
  const testBuild = process.env.PI_LAB_UPDATE_TEST_BUILD === "1"
  if (testBuild) publicUpdateUrl(process.env.PI_LAB_UPDATE_URL, true)
  assertPublicReleaseCredentials(process.env, testBuild)
  const root = join(RELEASE_ROOT, "public")
  const destination = publicReleaseDestination(root, release.channel, release.version)
  if (lstatSync(destination, { throwIfNoEntry: false })) {
    throw new Error(`Public release already exists: ${destination}`)
  }
  const unlock = acquireBuildLock(RELEASE_ROOT, `public-${release.channel}`)
  const stage = join(root, ".staging", `${Date.now()}-${process.pid}-${randomUUID()}`)
  try {
    mkdirSync(stage, { recursive: true })
    runBuildSteps(
      {
        ...process.env,
        PI_LAB_CHANNEL: "stable",
        PI_LAB_PUBLIC_RELEASE_CHANNEL: release.channel,
        PI_LAB_RELEASE_VERSION: release.version,
        PI_LAB_PACKAGE_STAGE: stage,
      },
      true,
      // Keep metadata generation local even when a GitHub token is available.
      PUBLIC_RELEASE_PUBLISH_MODE,
    )
    writeCompatibilityMetadata(stage, release.updaterChannel)
    fanOutUpdateMetadata(stage, release.updaterChannel)
    if (lstatSync(destination, { throwIfNoEntry: false })) {
      throw new Error(`Public release already exists: ${destination}`)
    }
    mkdirSync(join(root, release.channel), { recursive: true })
    renameSync(stage, destination)
    process.stdout.write(`Public ${release.channel} artifacts: ${destination}\n`)
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  } finally {
    unlock()
  }
}

if (require.main === module) {
  try {
    packagePublicRelease(process.argv[2], process.argv[3])
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}

module.exports = {
  PUBLIC_RELEASE_PUBLISH_MODE,
  fanOutUpdateMetadata,
  packagePublicRelease,
  publicReleaseDestination,
  writeCompatibilityMetadata,
}
