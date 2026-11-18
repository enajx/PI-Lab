import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { PublicUpdateChannel } from "../main/updates/release"
import { compareVersions } from "../shared/serverVersion"
import { writeOwnerOnly } from "./access"
import type { ServerConfig, ServerInstall } from "./config"

/**
 * Self-update of a server installed by install.sh (the server bundle): on
 * start and about daily, when "Update machines automatically" is on, look
 * for a newer server bundle of the server's update channel in the GitHub
 * releases, download it, check its SHA-256 and run install.sh for it.
 * install.sh restarts only the server (agents keep running in the PTY
 * daemon) and rolls back to this version and the pre-migration database copy
 * when the new version does not start.
 *
 * Feed: the GitHub releases list (`/repos/enajx/PI-Lab/releases`). A release
 * `v<version>` offers a server update when it has the assets
 * `pi-lab-server-<version>-darwin-<arch>.tar.gz` and its `.sha256` (the same
 * files the one-line installer downloads). Stable takes releases that are not
 * prereleases; Beta takes both.
 */

export const RELEASES_URL = "https://api.github.com/repos/enajx/PI-Lab/releases?per_page=30"

/** The server's update setting, in the data folder (the server reads it without the database). */
export const UPDATE_SETTINGS_FILE = "update-settings.json"
/** Where install.sh output of a self-update goes. */
export const UPDATE_LOG_FILE = "server-update.log"

const CHECK_EVERY_MS = 24 * 60 * 60_000
const FETCH_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000

const updateSettingsSchema = z.object({ autoUpdate: z.boolean() })
export type UpdateSettings = z.infer<typeof updateSettingsSchema>

/** "Update machines automatically" for this server; on when never set. */
export function readUpdateSettings(dataDir: string): UpdateSettings {
  const path = join(dataDir, UPDATE_SETTINGS_FILE)
  if (!existsSync(path)) return { autoUpdate: true }
  return updateSettingsSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export function writeUpdateSettings(dataDir: string, settings: UpdateSettings): void {
  writeOwnerOnly(join(dataDir, UPDATE_SETTINGS_FILE), `${JSON.stringify(settings)}\n`)
}

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
})
type Release = z.infer<typeof releaseSchema>

/** A server bundle newer than the running server. */
export interface ServerUpdate {
  version: string
  tarballName: string
  tarballUrl: string
  sha256Url: string
}

/**
 * The newest release of `channel` with a server bundle for `arch` that is
 * newer than `current` and not in `failed` (versions that did not start).
 */
export function pickServerUpdate(
  releases: Release[],
  channel: PublicUpdateChannel,
  current: string,
  arch: string,
  failed: string[],
): ServerUpdate | null {
  let best: ServerUpdate | null = null
  for (const release of releases) {
    if (release.draft || (channel === "stable" && release.prerelease)) continue
    const version = release.tag_name.replace(/^v/, "")
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) || failed.includes(version)) continue
    if (compareVersions(version, current) <= 0) continue
    if (best !== null && compareVersions(version, best.version) <= 0) continue
    const tarballName = `pi-lab-server-${version}-darwin-${arch}.tar.gz`
    const tarball = release.assets.find((asset) => asset.name === tarballName)
    const sum = release.assets.find((asset) => asset.name === `${tarballName}.sha256`)
    if (!tarball || !sum) continue
    best = {
      version,
      tarballName,
      tarballUrl: tarball.browser_download_url,
      sha256Url: sum.browser_download_url,
    }
  }
  return best
}

/** Versions install.sh could not start (`<prefix>/failed-versions`). */
function failedVersions(install: ServerInstall): string[] {
  const path = join(install.prefix, "failed-versions")
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

async function download(url: string, file: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`download of ${url} failed: HTTP ${response.status}`)
  await writeFile(file, Buffer.from(await response.arrayBuffer()))
}

export interface SelfUpdateOptions {
  config: ServerConfig
  /** The update channel in the server's settings (Stable or Beta). */
  channel: () => PublicUpdateChannel
  /** The releases list URL: {@link RELEASES_URL}; tests serve a local one. */
  releasesUrl: string
  /** Wait after start before the first check. */
  startDelayMs: number
  log: (message: string) => void
}

/** Checks for, downloads and installs newer server bundles (see the module comment). */
export class ServerSelfUpdate {
  readonly #options: SelfUpdateOptions
  #timer: NodeJS.Timeout | null = null
  #running: Promise<void> | null = null

  constructor(options: SelfUpdateOptions) {
    this.#options = options
  }

  /** Check once after the start delay, then about daily. Does nothing for a server not installed by install.sh. */
  start(): void {
    if (this.#options.config.install === null) return
    const run = (): void => {
      void this.check().catch((error: unknown) =>
        this.#options.log(`[pi-lab server] update check failed: ${String(error)}`),
      )
    }
    this.#timer = setTimeout(() => {
      run()
      this.#timer = setInterval(run, CHECK_EVERY_MS)
      this.#timer.unref()
    }, this.#options.startDelayMs)
    this.#timer.unref()
  }

  stop(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
  }

  /** One check; installs an update when one is found and the setting is on. One at a time. */
  check(): Promise<void> {
    this.#running ??= this.#check().finally(() => {
      this.#running = null
    })
    return this.#running
  }

  async #check(): Promise<void> {
    const { config, log } = this.#options
    const install = config.install
    if (install === null || !readUpdateSettings(config.dataDir).autoUpdate) return
    const response = await fetch(this.#options.releasesUrl, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`release list: HTTP ${response.status}`)
    const releases = z.array(releaseSchema).parse(await response.json())
    const update = pickServerUpdate(
      releases,
      this.#options.channel(),
      config.version,
      process.arch,
      failedVersions(install),
    )
    if (update === null) return
    log(`[pi-lab server] updating from ${config.version} to ${update.version}`)
    const dir = join(install.prefix, "downloads")
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const tarball = join(dir, update.tarballName)
    await download(update.tarballUrl, tarball)
    await download(update.sha256Url, `${tarball}.sha256`)
    const expected = readFileSync(`${tarball}.sha256`, "utf8").trim().split(/\s+/)[0]
    const actual = await sha256Of(tarball)
    if (actual !== expected) {
      throw new Error(`${update.tarballName} has SHA-256 ${actual}, expected ${expected}`)
    }
    runInstaller(config, install, tarball)
  }
}

/**
 * Run this version's install.sh for `tarball`, detached in its own process
 * group: it stops this server, so it must outlive it. Output goes to
 * {@link UPDATE_LOG_FILE} in the data folder.
 */
function runInstaller(config: ServerConfig, install: ServerInstall, tarball: string): void {
  const log = openSync(join(config.dataDir, UPDATE_LOG_FILE), "a")
  const args = [
    join(install.root, "bin", "install.sh"),
    "--from-file",
    tarball,
    "--prefix",
    install.prefix,
    "--data-dir",
    config.dataDir,
    ...(install.label === null ? ["--no-launchd"] : ["--label", install.label]),
  ]
  const child = spawn("/bin/sh", args, { detached: true, stdio: ["ignore", log, log] })
  child.unref()
}
