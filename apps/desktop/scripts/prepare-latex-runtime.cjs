// @ts-check
const { createHash } = require("node:crypto")
const { execFileSync } = require("node:child_process")
const {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  renameSync,
} = require("node:fs")
const { join } = require("node:path")
const manifest = require("../resources/latex/manifest.json")
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const MAX_BINARY_BYTES = 128 * 1024 * 1024

/** Select the exact native target; Windows ARM has no upstream release asset. */
function selectAsset(platform, arch) {
  const asset = manifest.assets[`${platform}-${arch}`]
  if (!asset)
    throw new Error(
      `Unsupported bundled Tectonic target: ${platform}-${arch}. Tectonic ${manifest.version} has no pinned official binary for this target.`,
    )
  return asset
}

/** Download at build time with bounded size and duration. */
async function downloadArchive(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`Tectonic download failed: HTTP ${response.status}`)
  if (Number(response.headers.get("content-length")) > MAX_DOWNLOAD_BYTES)
    throw new Error("Tectonic archive exceeds download limit")
  if (!response.body) throw new Error("Tectonic download returned no body")
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > MAX_DOWNLOAD_BYTES) throw new Error("Tectonic archive exceeds download limit")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Verify cached bytes before every extraction, including offline builds. */
function verifyArchive(data, expected) {
  if (data.length > MAX_DOWNLOAD_BYTES) throw new Error("Tectonic archive exceeds download limit")
  const actual = createHash("sha256").update(data).digest("hex")
  if (actual !== expected)
    throw new Error(`Tectonic archive SHA-256 mismatch: expected ${expected}, got ${actual}`)
}

/** Prepare the same resources/latex target layout used by dev and packaged apps. */
async function prepareLatexRuntime(options) {
  const { platform, arch, resourcesDir, cacheDir } = options
  const asset = options.asset || selectAsset(platform, arch)
  const archivePath = join(cacheDir, asset.filename)
  mkdirSync(cacheDir, { recursive: true })
  const data = existsSync(archivePath)
    ? readFileSync(archivePath)
    : await (options.download || downloadArchive)(`${manifest.releaseUrl}/${asset.filename}`)
  verifyArchive(data, asset.sha256)
  if (!existsSync(archivePath)) writeFileSync(archivePath, data)
  const executable = platform === "win32" ? "tectonic.exe" : "tectonic"
  // macOS/Linux tar and Windows' built-in bsdtar handle their native release archives.
  const binary = execFileSync("tar", ["-xOf", archivePath, executable], {
    maxBuffer: MAX_BINARY_BYTES,
    timeout: 30_000,
  })
  if (!binary.length) throw new Error("Tectonic archive contains an empty executable")
  const targetDir = join(resourcesDir, `${platform}-${arch}`)
  mkdirSync(targetDir, { recursive: true })
  const target = join(targetDir, executable)
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, binary)
  chmodSync(temporary, 0o755)
  renameSync(temporary, target)
  return target
}

/** electron-builder passes architecture as an enum rather than the native string. */
async function prepareForPack(context) {
  const arch = ["ia32", "x64", "armv7l", "arm64", "universal"][context.arch]
  if (!arch) throw new Error(`Unknown electron-builder architecture: ${context.arch}`)
  return prepareLatexRuntime({
    platform: context.electronPlatformName,
    arch,
    resourcesDir: join(__dirname, "../resources/latex"),
    cacheDir: join(__dirname, "../../../.cache/tectonic"),
  })
}

module.exports = {
  selectAsset,
  prepareLatexRuntime,
  prepareForPack,
  verifyArchive,
  downloadArchive,
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const platform = args[0] || process.platform
  const arch = args[1] || process.arch
  prepareLatexRuntime({
    platform,
    arch,
    resourcesDir: join(__dirname, "../resources/latex"),
    cacheDir: join(__dirname, "../../../.cache/tectonic"),
  })
    .then((path) => console.log(`Prepared Tectonic ${manifest.version}: ${path}`))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
