import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
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
    const target = join(toolsDir, "quarto")
    await rm(target, { recursive: true, force: true })
    await rename(extracted, target)
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
 * Install the mystmd npm package into `<toolsDir>/mystmd` with
 * `npm install --prefix`, never globally. Needs Node.js. Returns the path of
 * the `myst` command, after checking that `myst --version` runs.
 */
export async function installMystmd(options: MystInstallOptions): Promise<string> {
  if (!options.npmPath)
    throw new Error(
      "Installing MyST needs Node.js (the npm command), which was not found. Install Node.js from https://nodejs.org, then try again.",
    )
  const prefix = join(options.toolsDir, "mystmd")
  await mkdir(prefix, { recursive: true })
  options.onProgress("installing", null)
  await run(options.npmPath, ["install", "--prefix", prefix, "mystmd", "--no-audit", "--no-fund"], {
    env: options.env,
    timeout: 600_000,
    maxBuffer: 16 * 1024 ** 2,
  }).catch((error: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(
      `npm could not install mystmd.\n${error.stderr ?? ""}${error.stdout ?? ""}`.trim(),
    )
  })
  options.onProgress("validating", null)
  const path = piLabToolPath(options.toolsDir, "myst")
  await run(path, ["--version"], { env: options.env, timeout: 60_000 })
  return path
}
