import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)
const RELEASE = "v2026.10"
const MAX_EXPANDED_BYTES = 2 * 1024 ** 3

export interface TinyTexArtifact {
  url: string
  sha256: string
  size: number
  format: "tar" | "zip"
}
// SHA-256 digests and exact sizes from the official GitHub release API for v2026.10.
const ARCHIVES: Record<string, [string, number, string]> = {
  darwin: [
    "TinyTeX-darwin",
    210535256,
    "9962e445b56f06feb2c28f73561e523e89d550e98abf910ba60b0ffb3856921f",
  ],
  "linux-arm64": [
    "TinyTeX-linux-arm64",
    158454704,
    "e4caa195211d4ae8b557a52752c850f63027450065ed7db3d9350ba63e0e1aac",
  ],
  "linux-x64": [
    "TinyTeX-linux-x86_64",
    151904844,
    "54fec1c79ab437d2d52e2f918bdb738c85779d654a93e62cc44f022e227692b5",
  ],
  win32: ["TinyTeX", 247389422, "dc1d6e63b21af62130ede1dcc4113bffdc184544690a23e3f489d75340f4ff61"],
}

export interface PdfLatexInstallation {
  installDir: string
  binDir: string
  pdflatexPath: string
  latexmkPath: string
  synctexPath: string | null
  reusedExisting: boolean
  restartRequired: true
}
export interface SharedPathOptions {
  binDir: string
  userHome: string
  platform: NodeJS.Platform
}
export type PdfLatexInstallStage = "downloading" | "extracting" | "validating" | "registering"

export interface PdfLatexInstallOptions {
  installDir: string
  userHome: string
  platform: NodeJS.Platform
  arch: string
  onProgress?: (stage: PdfLatexInstallStage) => void
  registration?: (options: SharedPathOptions) => Promise<void>
  dependencies?: {
    artifact?: TinyTexArtifact
    download?: (artifact: TinyTexArtifact) => Promise<Buffer>
  }
}

/** Return the standard per-user TinyTeX location, shared by all applications. */
export function defaultPdfLatexInstallDir(userHome: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") return path.join(userHome, "Library", "TinyTeX")
  if (platform === "win32") return path.join(userHome, "AppData", "Roaming", "TinyTeX")
  return path.join(userHome, ".TinyTeX")
}

function artifactFor(platform: NodeJS.Platform, arch: string): TinyTexArtifact {
  const key = platform === "linux" ? `${platform}-${arch}` : platform
  const entry = ARCHIVES[key]
  if (!entry || !["arm64", "x64"].includes(arch) || (platform === "win32" && arch !== "x64")) {
    throw new Error(
      `PDFLaTeX installation is unavailable for ${platform}/${arch}. Install TeX Live manually.`,
    )
  }
  const [name, size, sha256] = entry
  const format = platform === "win32" ? "zip" : "tar"
  const filename = `${name}-${RELEASE}.${format === "zip" ? "zip" : "tar.xz"}`
  return {
    url: `https://github.com/rstudio/tinytex-releases/releases/download/${RELEASE}/${filename}`,
    size,
    sha256,
    format,
  }
}

/** Download with a timeout and a hard byte limit before verifying the pinned digest. */
async function downloadArchive(artifact: TinyTexArtifact): Promise<Buffer> {
  const response = await fetch(artifact.url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || !response.body)
    throw new Error(`TinyTeX download failed: HTTP ${response.status}`)
  const chunks: Buffer[] = []
  let size = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > artifact.size) {
        await reader.cancel()
        throw new Error("TinyTeX download exceeds the pinned archive size")
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Append a shared user PATH entry without changing existing command precedence. */
export async function registerSharedPdfLatex(options: SharedPathOptions): Promise<void> {
  const { binDir, userHome, platform } = options
  if (platform === "win32") {
    const literal = `'${binDir.replaceAll("'", "''")}'`
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p=[string][Environment]::GetEnvironmentVariable('Path','User'); $b=${literal}; if(-not (($p -split ';') -contains $b)) { [Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';')+';'+$b).TrimStart(';')), 'User') }`,
      ],
      { timeout: 30_000, maxBuffer: 64 * 1024 },
    )
    return
  }
  const start = "# >>> PI Lab shared PDFLaTeX >>>"
  const end = "# <<< PI Lab shared PDFLaTeX <<<"
  const quoted = quoteShell(binDir)
  const block = `${start}\ncase ":$PATH:" in\n  *:${quoted}:*) ;;\n  *) export PATH="$PATH":${quoted} ;;\nesac\n${end}`
  // Both login and interactive shells are used by terminals and VS Code.
  for (const filename of [".profile", ".bash_profile", ".bashrc", ".zprofile", ".zshrc"]) {
    const profilePath = path.join(userHome, filename)
    const exists = await pathExists(profilePath)
    if (filename === ".bash_profile" && !exists) continue
    const content = exists ? await readFile(profilePath, "utf8") : ""
    const from = content.indexOf(start)
    const to = content.indexOf(end)
    if (from < 0 !== to < 0 || (from >= 0 && to < from))
      throw new Error(`Incomplete PDFLaTeX PATH block in ${profilePath}`)
    const next =
      from < 0
        ? `${content}${content.endsWith("\n") || !content ? "" : "\n"}\n${block}\n`
        : `${content.slice(0, from)}${block}${content.slice(to + end.length)}`
    if (next !== content) await writeFile(profilePath, next, { mode: 0o644 })
  }
}

async function pathExists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
}

/** Verify required tools, including latexmk's Perl dependency, and optional SyncTeX. */
async function validateInstallation(
  installDir: string,
  platform: NodeJS.Platform,
): Promise<Omit<PdfLatexInstallation, "reusedExisting" | "restartRequired">> {
  const binRoot = path.join(installDir, "bin")
  if (!(await pathExists(binRoot)))
    throw new Error(`The existing TinyTeX directory has no bin directory: ${installDir}`)
  const candidates = await readdir(binRoot)
  for (const candidate of candidates) {
    const binDir = path.join(binRoot, candidate)
    const suffix = platform === "win32" ? ".exe" : ""
    const pdflatexPath = path.join(binDir, `pdflatex${suffix}`)
    const latexmkPath = path.join(binDir, `latexmk${suffix}`)
    const candidateSynctexPath = path.join(binDir, `synctex${suffix}`)
    const synctexPath = (await pathExists(candidateSynctexPath)) ? candidateSynctexPath : null
    if (!(await pathExists(pdflatexPath)) || !(await pathExists(latexmkPath))) continue
    const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }
    await run(pdflatexPath, ["--version"], { env, timeout: 30_000, maxBuffer: 64 * 1024 })
    await run(latexmkPath, ["-v"], { env, timeout: 30_000, maxBuffer: 64 * 1024 })
    if (synctexPath)
      await run(synctexPath, ["--version"], { env, timeout: 30_000, maxBuffer: 64 * 1024 })
    return { installDir, binDir, pdflatexPath, latexmkPath, synctexPath }
  }
  throw new Error(
    `The existing TinyTeX installation is incomplete: ${installDir}. PDFLaTeX and latexmk are required. Repair it manually; PI Lab will not overwrite it.`,
  )
}

/** Check extracted files and links stay inside the archive and bound its expanded size. */
async function validateExtractedTree(root: string): Promise<void> {
  let bytes = 0
  let entries = 0
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const filename = path.join(directory, name)
      const stat = await lstat(filename)
      entries += 1
      bytes += stat.size
      if (bytes > MAX_EXPANDED_BYTES || entries > 100_000)
        throw new Error("TinyTeX archive exceeds extraction limits")
      if (stat.isSymbolicLink()) {
        const target = path.resolve(directory, await readlink(filename))
        if (!target.startsWith(`${root}${path.sep}`))
          throw new Error("TinyTeX archive contains an external symbolic link")
      } else if (stat.isDirectory()) await visit(filename)
      else if (!stat.isFile()) throw new Error("TinyTeX archive contains an unsupported file")
    }
  }
  await visit(root)
}

/** Remove only this exact owner's file; never recursively remove a lock directory. */
async function removeOwnedLock(lockPath: string, ownerName: string): Promise<boolean> {
  const removed = await unlink(path.join(lockPath, ownerName)).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
  if (removed) await rmdir(lockPath)
  return removed
}

/** Claim an exclusive lock, safely recovering a directory left by a dead owner. */
async function acquireInstallLock(lockPath: string): Promise<() => Promise<void>> {
  const ownerName = `${process.pid}-${randomUUID()}.owner`
  const manualError = () =>
    new Error(
      `PDFLaTeX setup found an unrecognized lock: ${lockPath}. Remove this lock manually only when no installer is running, then retry.`,
    )
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const created = await mkdir(lockPath).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return false
        throw error
      },
    )
    if (created) {
      await writeFile(path.join(lockPath, ownerName), "", { flag: "wx" })
      return async () => {
        await removeOwnedLock(lockPath, ownerName)
      }
    }
    const stat = await lstat(lockPath).then(
      (value) => value,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      },
    )
    if (!stat) continue
    if (!stat.isDirectory()) throw manualError()
    const owners = await readdir(lockPath).then(
      (value) => value,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      },
    )
    if (!owners) continue
    const owner = owners.length === 1 ? owners[0] : undefined
    const match = owner?.match(/^([1-9][0-9]*)-[a-zA-Z0-9-]+\.owner$/)
    if (!owner || !match) throw manualError()
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) throw manualError()
    const dead = await Promise.resolve()
      .then(() => process.kill(pid, 0))
      .then(
        () => false,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ESRCH") return true
          if (error.code === "EPERM") return false
          throw error
        },
      )
    if (!dead)
      throw new Error(`Another PDFLaTeX installer is running (process ${pid}). Lock: ${lockPath}`)
    await removeOwnedLock(lockPath, owner)
  }
  throw new Error(`PDFLaTeX installation lock changed during setup. Retry. Lock: ${lockPath}`)
}

/** Install verified TinyTeX on demand, leaving any existing installation intact. */
export async function installPdfLatex(
  options: PdfLatexInstallOptions,
): Promise<PdfLatexInstallation> {
  const { installDir, userHome, platform, arch } = options
  if (!path.isAbsolute(installDir) || !path.isAbsolute(userHome))
    throw new Error("PDFLaTeX installation paths must be absolute")
  const register = options.registration ?? registerSharedPdfLatex
  if (await pathExists(installDir)) {
    options.onProgress?.("validating")
    const result = await validateInstallation(installDir, platform)
    options.onProgress?.("registering")
    await register({ binDir: result.binDir, userHome, platform })
    return { ...result, reusedExisting: true, restartRequired: true }
  }
  const artifact = options.dependencies?.artifact ?? artifactFor(platform, arch)
  await mkdir(path.dirname(installDir), { recursive: true })
  // Exclusive lock also prevents separate PI Lab instances racing this directory.
  const lockPath = `${installDir}.pi-lab-install.lock`
  const releaseLock = await acquireInstallLock(lockPath)
  let staging: string | undefined
  try {
    if (await pathExists(installDir))
      throw new Error("An existing TinyTeX installation appeared during setup; retry to use it")
    staging = await mkdtemp(`${installDir}.pi-lab-stage-`)
    options.onProgress?.("downloading")
    const bytes = await (options.dependencies?.download ?? downloadArchive)(artifact)
    if (
      bytes.length !== artifact.size ||
      createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
    )
      throw new Error("TinyTeX archive verification failed")
    const archive = path.join(staging, artifact.format === "zip" ? "tinytex.zip" : "tinytex.tar.xz")
    await writeFile(archive, bytes)
    const listing = await run("tar", ["-tf", archive], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 ** 2,
    })
    const names = listing.stdout.split(/\r?\n/).filter(Boolean)
    if (
      !names.length ||
      names.some((name) => /(^[/\\]|^[a-z]:|(^|[/\\])\.\.([/\\]|$))/i.test(name))
    )
      throw new Error("TinyTeX archive contains unsafe paths")
    const extracted = path.join(staging, "extracted")
    await mkdir(extracted)
    options.onProgress?.("extracting")
    // bsdtar (macOS/Windows) and GNU tar reject writes through unsafe archive links.
    await run("tar", ["-xf", archive, "-C", extracted], { timeout: 180_000, maxBuffer: 64 * 1024 })
    await validateExtractedTree(extracted)
    const roots = await readdir(extracted)
    const root = roots.find((entry) => entry.toLowerCase().replace(/^\./, "") === "tinytex")
    if (!root) throw new Error("TinyTeX archive has no installation directory")
    const source = path.join(extracted, root)
    options.onProgress?.("validating")
    await validateInstallation(source, platform)
    if (await pathExists(installDir))
      throw new Error(
        "An existing TinyTeX installation appeared during setup; refusing to overwrite it",
      )
    await rename(source, installDir)
    const result = await validateInstallation(installDir, platform)
    options.onProgress?.("registering")
    await register({ binDir: result.binDir, userHome, platform })
    return { ...result, reusedExisting: false, restartRequired: true }
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true })
    await releaseLock()
  }
}
