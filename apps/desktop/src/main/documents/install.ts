import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { piLabToolPath } from "./tools"

/**
 * Install Quarto and MyST (mystmd) into PI Lab's own tools folder
 * (`<data folder>/tools`), without admin rights and without changing the
 * user's PATH or global npm packages.
 */

const run = promisify(execFile)

export type DocumentToolInstallStage = "downloading" | "extracting" | "validating" | "installing"

/** A pinned release archive: its URL, exact size and SHA-256 digest. */
export interface ReleaseArtifact {
  url: string
  size: number
  sha256: string
}

/** Quarto 1.11.9 for macOS (Apple silicon and Intel), from the official GitHub release. */
export const QUARTO_MACOS_ARTIFACT: ReleaseArtifact = {
  url: "https://github.com/quarto-dev/quarto-cli/releases/download/v1.11.9/quarto-1.11.9-macos.tar.gz",
  size: 236802854,
  sha256: "9fc24881f637612d80edbf16d62f01001fc7945a9a0c6ac247199002901e0a6d",
}

/** The mystmd npm version PI Lab installs (the latest release when this was pinned). */
export const MYSTMD_VERSION = "1.12.0"

/**
 * Move the folder `staged` to `target`. An old `target` is first renamed to a
 * temporary name and removed only after the move worked; when the move fails it
 * is put back, so a failed update keeps the old install.
 */
export async function swapInto(staged: string, target: string): Promise<void> {
  const backup = `${target}.pi-lab-old-${randomBytes(4).toString("hex")}`
  const hadOld = existsSync(target)
  if (hadOld) await rename(target, backup)
  await rename(staged, target).catch(async (error: unknown) => {
    if (hadOld) await rename(backup, target)
    throw error
  })
  if (hadOld) await rm(backup, { recursive: true, force: true })
}

/** Download `artifact` with a timeout and a size limit, reporting the downloaded fraction. */
export async function downloadArtifact(
  artifact: ReleaseArtifact,
  onFraction: (fraction: number) => void,
): Promise<Buffer> {
  const response = await fetch(artifact.url, { signal: AbortSignal.timeout(15 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
  const chunks: Buffer[] = []
  let size = 0
  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > artifact.size) {
      await reader.cancel()
      throw new Error("The download is larger than the pinned archive")
    }
    chunks.push(Buffer.from(value))
    onFraction(size / artifact.size)
  }
  return Buffer.concat(chunks)
}

export interface QuartoInstallOptions {
  toolsDir: string
  platform: NodeJS.Platform
  artifact: ReleaseArtifact
  download: (artifact: ReleaseArtifact, onFraction: (fraction: number) => void) => Promise<Buffer>
  onProgress: (stage: DocumentToolInstallStage, fraction: number | null) => void
}

/**
 * Download the pinned Quarto archive, check its size and digest, extract it
 * into `<toolsDir>/quarto` and check that `quarto --version` runs. Returns the
 * path of the `quarto` command. A previous PI Lab install is replaced.
 */
export async function installQuarto(options: QuartoInstallOptions): Promise<string> {
  const { toolsDir, artifact } = options
  if (options.platform !== "darwin")
    throw new Error(
      "PI Lab installs Quarto only on macOS. Install Quarto from https://quarto.org, then check again.",
    )
  await mkdir(toolsDir, { recursive: true })
  const staging = await mkdtemp(join(toolsDir, "quarto.pi-lab-stage-"))
  const finish = () => rm(staging, { recursive: true, force: true })
  const installed = (async () => {
    options.onProgress("downloading", 0)
    const bytes = await options.download(artifact, (fraction) =>
      options.onProgress("downloading", fraction),
    )
    if (
      bytes.length !== artifact.size ||
      createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
    )
      throw new Error("Quarto archive verification failed (size or SHA-256 does not match)")
    const archive = join(staging, "quarto.tar.gz")
    await writeFile(archive, bytes)
    options.onProgress("extracting", null)
    const listing = await run("tar", ["-tzf", archive], { maxBuffer: 64 * 1024 ** 2 })
    if (
      listing.stdout
        .split("\n")
        .some((name) => name.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(name))
    )
      throw new Error("Quarto archive contains unsafe paths")
    const extracted = join(staging, "quarto")
    await mkdir(extracted)
    await run("tar", ["-xzf", archive, "-C", extracted], { timeout: 300_000 })
    options.onProgress("validating", null)
    await run(join(extracted, "bin", "quarto"), ["--version"], { timeout: 60_000 })
    await swapInto(extracted, join(toolsDir, "quarto"))
    return piLabToolPath(toolsDir, "quarto")
  })()
  return installed.finally(finish)
}

export interface MystInstallOptions {
  toolsDir: string
  /** The `npm` command, or null when it was not found. */
  npmPath: string | null
  env: Record<string, string>
  onProgress: (stage: DocumentToolInstallStage, fraction: number | null) => void
}

/**
 * Install mystmd {@link MYSTMD_VERSION} into `<toolsDir>/mystmd` with
 * `npm install --prefix`, never globally: npm installs into a staging folder,
 * `myst --version` is checked there, and only then it replaces an older install.
 * Needs Node.js. Returns the path of the `myst` command.
 */
export async function installMystmd(options: MystInstallOptions): Promise<string> {
  const npm = options.npmPath
  if (!npm)
    throw new Error(
      "Installing MyST needs Node.js (the npm command), which was not found. Install Node.js from https://nodejs.org, then try again.",
    )
  await mkdir(options.toolsDir, { recursive: true })
  const staging = await mkdtemp(join(options.toolsDir, "mystmd.pi-lab-stage-"))
  const installed = (async () => {
    options.onProgress("installing", null)
    await run(
      npm,
      ["install", "--prefix", staging, `mystmd@${MYSTMD_VERSION}`, "--no-audit", "--no-fund"],
      { env: options.env, timeout: 600_000, maxBuffer: 16 * 1024 ** 2 },
    ).catch((error: Error & { stdout?: string; stderr?: string }) => {
      throw new Error(
        `npm could not install mystmd.\n${error.stderr ?? ""}${error.stdout ?? ""}`.trim(),
      )
    })
    options.onProgress("validating", null)
    await run(join(staging, "node_modules", ".bin", "myst"), ["--version"], {
      env: options.env,
      timeout: 60_000,
    })
    await swapInto(staging, join(options.toolsDir, "mystmd"))
    return piLabToolPath(options.toolsDir, "myst")
  })()
  return installed.finally(() => rm(staging, { recursive: true, force: true }))
}
