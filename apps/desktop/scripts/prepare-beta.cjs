// @ts-check
const { execFileSync } = require("node:child_process")
const { createHash } = require("node:crypto")
const {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  writeFileSync,
} = require("node:fs")
const { join } = require("node:path")
const { publicReleaseDefinition } = require("./public-release.cjs")

const MAX_METADATA_BYTES = 2 * 1024 * 1024
const MAX_ASSET_BYTES = 3 * 1024 ** 3
const BETA_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/

/** @typedef {{name: string, size: number, sha256: string}} BetaAsset */
/** @typedef {{schemaVersion: number, version: string, tag: string, commit: string, previousTag: string|null, repo: string, arch: string, assets: BetaAsset[], notesSha256: string}} BetaManifest */
/** @typedef {{version: string, commit: string, artifactDir: string, previousTag: string|null, repo: string}} ManifestOptions */
/** @typedef {(args: string[]) => string} GitHubRunner */

/** Accept only the numeric Beta versions supported by this release action. */
function validateBetaVersion(version) {
  if (typeof version !== "string" || version.length > 64 || !BETA_VERSION.test(version))
    throw new Error("Beta version must look like 0.1.0-beta.4, with no leading zeroes")
  publicReleaseDefinition("beta", version)
  return version
}

/** Compare numeric Beta versions without relying on installed dependencies. */
function compareBetaVersions(left, right) {
  validateBetaVersion(left)
  validateBetaVersion(right)
  const a = left.match(BETA_VERSION).slice(1).map(BigInt)
  const b = right.match(BETA_VERSION).slice(1).map(BigInt)
  const difference = a.findIndex((part, index) => part !== b[index])
  if (difference < 0) return 0
  return a[difference] < b[difference] ? -1 : 1
}

/** Keep release destinations and pinned commit values out of shell or URL syntax. */
function validateIdentity(version, commit, previousTag, repo) {
  validateBetaVersion(version)
  if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit))
    throw new Error("Source commit must be a full lowercase 40-character Git commit SHA")
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error("Repository must be owner/name")
  if (previousTag !== null) {
    if (typeof previousTag !== "string" || !previousTag.startsWith("v"))
      throw new Error("Previous Beta tag must start with v")
    if (compareBetaVersions(version, previousTag.slice(1)) <= 0)
      throw new Error("The candidate version must be newer than the previous Beta")
  }
}

/** Reject directories and links before reading a candidate file. */
function regularFile(filename, limit) {
  const stat = lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Candidate must contain regular files, without symbolic links: ${filename}`)
  if (stat.size <= 0 || stat.size > limit)
    throw new Error(`Candidate file size is outside release limits: ${filename}`)
  return stat
}

/** Hash large archives in bounded chunks instead of reading them into memory. */
function digestFile(filename, algorithm) {
  regularFile(filename, MAX_ASSET_BYTES)
  const hash = createHash(algorithm)
  const fd = openSync(filename, "r")
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    let count = readSync(fd, chunk, 0, chunk.length, null)
    while (count > 0) {
      hash.update(chunk.subarray(0, count))
      count = readSync(fd, chunk, 0, chunk.length, null)
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest(algorithm === "sha512" ? "base64" : "hex")
}

/** Release uploads deliberately exclude the app directory and DMG blockmap. */
function assetNames(version, arch) {
  if (!["arm64", "x64"].includes(arch)) throw new Error("Candidate architecture is invalid")
  const stem = `PI-Lab-${version}-${arch}`
  return [`${stem}.dmg`, `${stem}.zip`, `${stem}.zip.blockmap`, "beta-mac.yml"]
}

/** Bound release metadata and reject a redirected candidate directory. */
function readMetadata(artifactDir, name) {
  const directory = lstatSync(artifactDir)
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("Candidate directory must be a regular directory")
  const filename = join(artifactDir, name)
  regularFile(filename, MAX_METADATA_BYTES)
  return readFileSync(filename, "utf8")
}

/** Verify the updater feed against the exact ZIP/DMG bytes before accepting a build. */
function verifyFeed(artifactDir, version, arch) {
  // Installed build dependencies are needed only when preparing the candidate.
  const { parseUpdateInfo } = require("electron-updater/out/providers/Provider")
  const feed = parseUpdateInfo(readMetadata(artifactDir, "beta-mac.yml"), "beta-mac.yml", {})
  if (feed.version !== version)
    throw new Error("Updater feed version does not match the Beta version")
  const archives = assetNames(version, arch).slice(0, 2)
  const zip = archives.find((name) => name.endsWith(".zip"))
  if (!Array.isArray(feed.files) || !feed.files.some(({ url }) => url === zip))
    throw new Error("Updater feed must reference the candidate ZIP")
  const seen = new Set()
  for (const file of feed.files) {
    if (!archives.includes(file.url) || seen.has(file.url))
      throw new Error("Updater feed contains an unexpected or duplicate asset path")
    seen.add(file.url)
    const filename = join(artifactDir, file.url)
    const stat = regularFile(filename, MAX_ASSET_BYTES)
    if (file.size !== undefined && file.size !== stat.size)
      throw new Error(`Updater feed size does not match ${file.url}`)
    if (file.sha512 !== digestFile(filename, "sha512"))
      throw new Error(`Updater feed SHA-512 does not match ${file.url}`)
  }
  if (feed.path !== undefined) {
    if (feed.path !== zip || feed.sha512 !== digestFile(join(artifactDir, zip), "sha512"))
      throw new Error("Legacy updater feed path or SHA-512 does not match the candidate ZIP")
  }
}

/**
 * Record exact release bytes after build/signing and release checks have passed.
 * This command prepares local metadata only and never contacts GitHub.
 * @param {ManifestOptions} options
 * @returns {BetaManifest}
 */
function createBetaManifest(options) {
  const { version, commit, artifactDir, repo } = options
  const previousTag = options.previousTag === "-" ? null : options.previousTag
  validateIdentity(version, commit, previousTag, repo)
  const candidates = ["arm64", "x64"].filter((arch) =>
    readdirSync(artifactDir).includes(`PI-Lab-${version}-${arch}.zip`),
  )
  if (candidates.length !== 1)
    throw new Error("Candidate must contain exactly one architecture ZIP")
  const arch = candidates[0]
  verifyFeed(artifactDir, version, arch)
  const assets = assetNames(version, arch).map((name) => ({
    name,
    size: regularFile(join(artifactDir, name), MAX_ASSET_BYTES).size,
    sha256: digestFile(join(artifactDir, name), "sha256"),
  }))
  const notes = previousTag
    ? `Beta prepared from [${commit.slice(0, 8)}](https://github.com/${repo}/commit/${commit}).\n\n[Changes since ${previousTag}](https://github.com/${repo}/compare/${previousTag}...${commit}).\n`
    : `Beta prepared from [${commit.slice(0, 8)}](https://github.com/${repo}/commit/${commit}).\n`
  writeFileSync(join(artifactDir, "release-notes.md"), notes)
  const manifest = {
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    commit,
    previousTag,
    repo,
    arch,
    assets,
    notesSha256: createHash("sha256").update(notes).digest("hex"),
  }
  writeFileSync(join(artifactDir, "prepare-beta.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/**
 * Validate transferred candidate files using only Node built-ins in the publish job.
 * @param {string} artifactDir
 * @returns {BetaManifest}
 */
function validateBetaManifest(artifactDir) {
  const manifest = JSON.parse(readMetadata(artifactDir, "prepare-beta.json"))
  const { version, commit, previousTag, repo, arch, assets } = manifest
  validateIdentity(version, commit, previousTag, repo)
  if (manifest.schemaVersion !== 1 || manifest.tag !== `v${version}`)
    throw new Error("Prepared Beta manifest identity is invalid")
  const expected = assetNames(version, arch)
  if (
    !Array.isArray(assets) ||
    assets.length !== expected.length ||
    !expected.every((name) => assets.filter((asset) => asset.name === name).length === 1)
  )
    throw new Error("Prepared Beta manifest contains an unexpected asset path or set")
  for (const asset of assets) {
    const filename = join(artifactDir, asset.name)
    if (
      !Number.isSafeInteger(asset.size) ||
      asset.size !== regularFile(filename, MAX_ASSET_BYTES).size ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      digestFile(filename, "sha256") !== asset.sha256
    )
      throw new Error(`Prepared Beta asset checksum or size changed: ${asset.name}`)
  }
  readMetadata(artifactDir, "release-notes.md")
  if (
    !/^[a-f0-9]{64}$/.test(manifest.notesSha256) ||
    digestFile(join(artifactDir, "release-notes.md"), "sha256") !== manifest.notesSha256
  )
    throw new Error("Prepared Beta release notes checksum changed")
  return manifest
}

/** Invoke gh without a shell and without printing credential environment variables. */
function runGitHub(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: MAX_METADATA_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

/** Missing release/tag is expected; every other GitHub failure stops publication. */
function assertUnclaimed(endpoint, label, run) {
  try {
    run(["api", endpoint])
  } catch (error) {
    const detail = String(error.stderr ?? error.message)
    if (/\bHTTP 404\b/.test(detail)) return
    throw new Error(`Unable to check ${label}: ${detail}`, { cause: error })
  }
  throw new Error(`${label} already exists; choose a new Beta version`)
}

/**
 * Create one draft prerelease, never publish or replace an existing release/tag.
 * @param {{artifactDir: string, repo: string}} options
 * @param {GitHubRunner} run
 * @returns {string}
 */
function publishBetaDraft(options, run) {
  const { artifactDir, repo } = options
  const manifest = validateBetaManifest(artifactDir)
  if (manifest.repo !== repo)
    throw new Error("Prepared Beta repository does not match the destination")
  assertUnclaimed(`repos/${repo}/releases/tags/${manifest.tag}`, "Beta release", run)
  assertUnclaimed(`repos/${repo}/git/ref/tags/${manifest.tag}`, "Beta tag", run)
  const tag = JSON.parse(
    run([
      "api",
      "--method",
      "POST",
      `repos/${repo}/git/refs`,
      "-f",
      `ref=refs/tags/${manifest.tag}`,
      "-f",
      `sha=${manifest.commit}`,
    ]),
  )
  if (tag.object?.sha !== manifest.commit)
    throw new Error(
      "New Beta tag does not point to the prepared source commit; draft creation stopped",
    )
  return run([
    "release",
    "create",
    manifest.tag,
    "--repo",
    repo,
    "--draft",
    "--prerelease",
    "--verify-tag",
    "--target",
    manifest.commit,
    "--title",
    `PI Lab ${manifest.version}`,
    "--notes-file",
    join(artifactDir, "release-notes.md"),
    ...manifest.assets.map(({ name }) => join(artifactDir, name)),
  ]).trim()
}

module.exports = {
  compareBetaVersions,
  createBetaManifest,
  publishBetaDraft,
  validateBetaManifest,
  validateBetaVersion,
}

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2)
  if (command === "manifest" && args.length === 5) {
    const [version, commit, artifactDir, previousTag, repo] = args
    const manifest = createBetaManifest({ version, commit, artifactDir, previousTag, repo })
    process.stdout.write(`${manifest.tag}: ${manifest.assets.length} release assets verified\n`)
  } else if (command === "publish" && args.length === 2) {
    const [artifactDir, repo] = args
    process.stdout.write(`${publishBetaDraft({ artifactDir, repo }, runGitHub)}\n`)
  } else {
    throw new Error(
      "Usage: prepare-beta.cjs manifest <version> <commit> <artifactDir> <previousTag-or-> <repo> | publish <artifactDir> <repo>",
    )
  }
}
