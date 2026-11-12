// @ts-check
/**
 * Build the bundled whisper.cpp dictation engine (`whisper-server`) from a
 * pinned source release. macOS only. The binary is static (no shared ggml or
 * whisper libraries) and embeds the Metal shader library, so the single file
 * in resources/whisper/darwin-<arch>/ is all the app needs at runtime.
 *
 * A stamp file next to the binary records the source digest and build flags; a
 * matching stamp skips the build, so repeat runs are instant.
 */
const { createHash } = require("node:crypto")
const { execFileSync } = require("node:child_process")
const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs")
const { join } = require("node:path")
const manifest = require("../resources/whisper/manifest.json")
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const CMAKE_ARCH = { arm64: "arm64", x64: "x86_64" }

/** Download the source tarball with a size limit and a timeout. */
async function downloadSource(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!response.ok) throw new Error(`whisper.cpp download failed: HTTP ${response.status}`)
  if (!response.body) throw new Error("whisper.cpp download returned no body")
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > MAX_DOWNLOAD_BYTES) throw new Error("whisper.cpp source exceeds download limit")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Reject any source tarball whose digest differs from the pinned one. */
function verifySource(data, expected) {
  const actual = createHash("sha256").update(data).digest("hex")
  if (actual !== expected)
    throw new Error(`whisper.cpp source SHA-256 mismatch: expected ${expected}, got ${actual}`)
}

/** CMake flags for a static, Metal-enabled, portable (non-native) build. */
function cmakeFlags(arch) {
  const cmakeArch = CMAKE_ARCH[arch]
  if (!cmakeArch) throw new Error(`Unsupported whisper.cpp architecture: ${arch}`)
  return [
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_OSX_ARCHITECTURES=${cmakeArch}`,
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${manifest.macosDeploymentTarget}`,
    "-DBUILD_SHARED_LIBS=OFF",
    "-DGGML_METAL=ON",
    "-DGGML_METAL_EMBED_LIBRARY=ON",
    "-DGGML_NATIVE=OFF",
    "-DWHISPER_BUILD_TESTS=OFF",
    "-DWHISPER_BUILD_EXAMPLES=ON",
    "-DWHISPER_BUILD_SERVER=ON",
    "-DWHISPER_SDL2=OFF",
    "-DWHISPER_CURL=OFF",
  ]
}

/** The cmake executable: CMAKE env override, else Homebrew's, else PATH. */
function cmakeExecutable() {
  if (process.env.CMAKE) return process.env.CMAKE
  return existsSync("/opt/homebrew/bin/cmake") ? "/opt/homebrew/bin/cmake" : "cmake"
}

/** Build `whisper-server` for one macOS architecture into resourcesDir/darwin-<arch>. */
async function prepareWhisperRuntime(options) {
  const { platform, arch, resourcesDir, cacheDir } = options
  if (platform !== "darwin")
    throw new Error(`Bundled dictation is macOS only; cannot build for ${platform}`)
  const flags = cmakeFlags(arch)
  const targetDir = join(resourcesDir, `${platform}-${arch}`)
  const target = join(targetDir, "whisper-server")
  const stampPath = join(targetDir, "BUILD")
  const stamp = JSON.stringify({ version: manifest.version, sha256: manifest.sha256, flags })
  if (existsSync(target) && existsSync(stampPath) && readFileSync(stampPath, "utf8") === stamp)
    return target

  mkdirSync(cacheDir, { recursive: true })
  const archivePath = join(cacheDir, manifest.filename)
  const data = existsSync(archivePath)
    ? readFileSync(archivePath)
    : await downloadSource(manifest.sourceUrl)
  verifySource(data, manifest.sha256)
  if (!existsSync(archivePath)) writeFileSync(archivePath, data)

  const workDir = join(cacheDir, `build-${platform}-${arch}`)
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  execFileSync("tar", ["-xzf", archivePath, "-C", workDir], { timeout: 120_000 })
  const sourceDir = join(workDir, manifest.sourceDir)
  const buildDir = join(workDir, "build")
  const cmake = cmakeExecutable()
  execFileSync(cmake, ["-S", sourceDir, "-B", buildDir, ...flags], { stdio: "inherit" })
  execFileSync(
    cmake,
    ["--build", buildDir, "--config", "Release", "--target", "whisper-server", "-j"],
    { stdio: "inherit" },
  )
  const built = join(buildDir, "bin", "whisper-server")
  if (!existsSync(built)) throw new Error(`whisper.cpp build produced no binary at ${built}`)

  mkdirSync(targetDir, { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  copyFileSync(built, temporary)
  chmodSync(temporary, 0o755)
  renameSync(temporary, target)
  writeFileSync(stampPath, stamp)
  rmSync(workDir, { recursive: true, force: true })
  return target
}

/** electron-builder passes architecture as an enum; non-macOS packages skip the engine. */
async function prepareForPack(context) {
  if (context.electronPlatformName !== "darwin") return null
  const arch = ["ia32", "x64", "armv7l", "arm64", "universal"][context.arch]
  if (!arch) throw new Error(`Unknown electron-builder architecture: ${context.arch}`)
  return prepareWhisperRuntime({
    platform: "darwin",
    arch,
    resourcesDir: join(__dirname, "../resources/whisper"),
    cacheDir: join(__dirname, "../../../.cache/whisper"),
  })
}

module.exports = { cmakeFlags, prepareWhisperRuntime, prepareForPack, verifySource }

if (require.main === module) {
  const args = process.argv.slice(2)
  const arch = args[0] || process.arch
  prepareWhisperRuntime({
    platform: process.platform,
    arch,
    resourcesDir: join(__dirname, "../resources/whisper"),
    cacheDir: join(__dirname, "../../../.cache/whisper"),
  })
    .then((path) => console.log(`Prepared whisper.cpp ${manifest.version}: ${path}`))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
