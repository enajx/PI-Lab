import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { resolveDataDir } from "@pi-lab/local-db/paths"
import {
  DISCOVERY_FILE,
  proveServerIdentity,
  readDiscovery,
  readLocalToken,
  type ServerDiscovery,
  serverAnswers,
} from "../../server/access"
import { type ServerConfig, serverConfigEnv } from "../../server/config"
import { readStartProgress, SERVER_START_FILE } from "../../server/startProgress"
import type { PiLabChannel } from "../identity/channel"

/** Where the desktop app finds its server and how it authenticates. */
export interface ServerEndpoint {
  port: number
  pid: number
  token: string
  build: string
  serverId: string
}

/** What the desktop app knows about its install when it starts the server. */
export interface LaunchInput {
  channel: PiLabChannel
  packaged: boolean
  resourcesDir: string
  build: string
  version: string
  /** Electron's profile folder (`app.getPath("userData")`). */
  profileDir: string
}

/**
 * The server's configuration. The data folder is the one the app used before
 * the server split, `resolveDataDir()`: `PI_LAB_DATA_DIR` when set (Alpha,
 * Beta and tests set it), else `~/.pi-lab`. It holds the database, daemon
 * socket, `server.json` and the token. Electron's profile folder (Application
 * Support for Stable) keeps only files the old app kept there.
 */
export function serverLaunchConfig(input: LaunchInput): ServerConfig {
  return {
    dataDir: resolveDataDir(),
    profileDir: input.profileDir,
    channel: input.channel,
    packaged: input.packaged,
    resourcesDir: input.resourcesDir,
    build: input.build,
    version: input.version,
    port: 0,
  }
}

/** How this app instance runs its server. */
export interface LauncherOptions {
  config: ServerConfig
  /** Absolute path of `out/main/server.js`. */
  serverEntry: string
  /** launchd label for packaged builds; null starts a detached child process instead. */
  launchdLabel: string | null
  log: (message: string) => void
  /**
   * How long a starting server may go without a new start step before the
   * start fails ({@link SERVER_START_NO_PROGRESS_MS} in the app). There is no
   * total limit: a slow start on a loaded machine is waited for while the
   * process lives and its steps advance.
   */
  noProgressMs: number
}

/** A fatal start error the server wrote before exiting (see server/index.ts). */
export interface ServerStartError {
  kind: "migration" | "other"
  message: string
}

export const SERVER_ERROR_FILE = "server-error.json"
export const SERVER_LOG_FILE = "server.log"
export const SERVER_START_NO_PROGRESS_MS = 120_000

/** Identity of a server bundle: changes whenever the built server code changes. */
export function serverBuildId(serverEntry: string): string {
  return createHash("sha256").update(readFileSync(serverEntry)).digest("hex").slice(0, 16)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The running server for this data folder, if it answers. The token is sent
 * only after the process on the port proved it holds the token (identity check).
 */
export async function runningServer(dataDir: string): Promise<ServerEndpoint | null> {
  const discovery = readDiscovery(dataDir)
  const token = readLocalToken(dataDir)
  if (!discovery?.serverId || !token || !processAlive(discovery.pid)) return null
  if (!(await serverAnswers(discovery, token))) return null
  return { ...discovery, token }
}

/** Check that the process on `discovery.port` proves it holds `token`. */
async function verified(discovery: ServerDiscovery | null, token: string): Promise<ServerEndpoint> {
  if (!discovery?.serverId) throw new Error("The PI Lab server is not running")
  if (!(await proveServerIdentity(discovery.port, token))) {
    throw new Error(`The process on port ${discovery.port} is not this PI Lab server`)
  }
  return { ...discovery, token }
}

/**
 * Where this data folder's server listens now, checked before any client
 * sends it the token. Throws when the process on the port in `server.json`
 * does not prove it holds the token.
 */
export async function verifiedEndpoint(dataDir: string, token: string): Promise<ServerEndpoint> {
  return verified(readDiscovery(dataDir), token)
}

/** A verified server endpoint kept between requests (see {@link createEndpointCache}). */
export interface EndpointCache {
  /** The verified endpoint; checked again only when needed. */
  get: () => Promise<ServerEndpoint>
  /** Forget the verified endpoint after a failed request or a closed connection. */
  invalidate: () => void
}

/**
 * Keep the verified endpoint so forwarded requests do not repeat the identity
 * check. `server.json` is read (async) on each `get`; the check runs again
 * only when its port or serverId changes (a restarted server), after
 * `invalidate`, or after a failed check.
 */
export function createEndpointCache(dataDir: string, token: string): EndpointCache {
  let cached: { key: string; endpoint: Promise<ServerEndpoint> } | null = null
  const path = join(dataDir, DISCOVERY_FILE)
  return {
    get: async () => {
      const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      })
      const discovery = text === null ? null : (JSON.parse(text) as ServerDiscovery)
      const key = `${discovery?.port}:${discovery?.serverId}`
      if (cached?.key === key) return cached.endpoint
      const entry = { key, endpoint: verified(discovery, token) }
      cached = entry
      entry.endpoint.catch(() => {
        if (cached === entry) cached = null
      })
      return entry.endpoint
    },
    invalidate: () => {
      cached = null
    },
  }
}

/**
 * True when `pid` runs a PI Lab server bundle for `dataDir`: its command line
 * ends with `…/out/main/server.js <dataDir>` (both start modes pass the data
 * folder as the argument).
 */
export function isPiLabServerProcess(pid: number, dataDir: string): boolean {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" })
  return result.status === 0 && result.stdout.trim().endsWith(`/out/main/server.js ${dataDir}`)
}

/** The launchd agent definition: the app binary in Node mode running server.js. */
export function launchdPlist(options: LauncherOptions): string {
  const env = {
    ...serverConfigEnv(options.config),
    ELECTRON_RUN_AS_NODE: "1",
    // Fixed values, so the plist does not change with how the app was opened.
    // Agents get the user's full environment from the login shell (SHELL).
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
    HOME: homedir(),
    SHELL: userInfo().shell ?? "/bin/zsh",
  }
  const escapeXml = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  const log = join(options.config.dataDir, SERVER_LOG_FILE)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(options.launchdLabel ?? "")}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(options.serverEntry)}</string>
    <string>${escapeXml(options.config.dataDir)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`)
  .join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(log)}</string>
</dict>
</plist>
`
}

function launchctl(args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: "pipe" })
    return { ok: true, output }
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; message: string }
    return { ok: false, output: `${failure.stdout ?? ""}${failure.stderr ?? failure.message}` }
  }
}

/** Install or refresh the per-user launchd agent and (re)start it. */
function startWithLaunchd(options: LauncherOptions): void {
  const label = options.launchdLabel
  if (!label) throw new Error("No launchd label")
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`)
  const plist = launchdPlist(options)
  const domain = `gui/${userInfo().uid}`
  const changed = !existsSync(plistPath) || readFileSync(plistPath, "utf8") !== plist
  if (changed) {
    mkdirSync(dirname(plistPath), { recursive: true })
    // Unload the old definition first so launchd reads the new one.
    launchctl(["bootout", `${domain}/${label}`])
    writeFileSync(plistPath, plist)
  }
  const loaded = launchctl(["print", `${domain}/${label}`]).ok
  if (!loaded) {
    const result = launchctl(["bootstrap", domain, plistPath])
    if (!result.ok) throw new Error(`launchctl bootstrap failed: ${result.output.trim()}`)
    return
  }
  const result = launchctl(["kickstart", `${domain}/${label}`])
  if (!result.ok) throw new Error(`launchctl kickstart failed: ${result.output.trim()}`)
}

/** Source and test runs: a detached child that outlives this app. */
function startDetached(options: LauncherOptions): ChildProcess {
  const log = openSync(join(options.config.dataDir, SERVER_LOG_FILE), "a")
  // The data folder on the command line names the process (`ps`, E2E cleanup,
  // isPiLabServerProcess); the server reads its configuration from the environment.
  const child = spawn(process.execPath, [options.serverEntry, options.config.dataDir], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, ...serverConfigEnv(options.config), ELECTRON_RUN_AS_NODE: "1" },
  })
  child.unref()
  return child
}

/** The last lines of the server log, for an error message. */
export function serverLogTail(dataDir: string): string {
  const path = join(dataDir, SERVER_LOG_FILE)
  if (!existsSync(path)) return ""
  return readFileSync(path, "utf8").split("\n").slice(-15).join("\n")
}

/** Stop a server this app started outside launchd (or an old one) by its pid. */
function stopByPid(pid: number): void {
  if (processAlive(pid)) process.kill(pid, "SIGTERM")
}

/**
 * Connect to this data folder's server, starting it when none runs. A server
 * built from different code is restarted, so the app and server always match;
 * agents keep running because the PTY daemon outlives the server.
 */
export async function ensureServer(options: LauncherOptions): Promise<ServerEndpoint> {
  const dataDir = options.config.dataDir
  mkdirSync(dataDir, { recursive: true })
  const current = await runningServer(dataDir)
  if (current && current.build === options.config.build) return current
  const old = current ? null : unprovenServerPid(dataDir)
  if (old !== null) {
    options.log(`[pi-lab] stopping server ${old}: it does not prove its identity (older build)`)
    stopByPid(old)
    await waitForExit(old)
  }
  if (current) {
    // A clean exit is not restarted by launchd, so the new definition starts next.
    options.log(`[pi-lab] restarting server ${current.pid}: build ${current.build} differs`)
    stopByPid(current.pid)
    await waitForExit(current.pid)
  }
  writeFileSync(join(dataDir, SERVER_ERROR_FILE), "", { flag: "w" })
  writeFileSync(join(dataDir, SERVER_START_FILE), "", { flag: "w" })
  let child: ChildProcess | null = null
  if (options.launchdLabel) startWithLaunchd(options)
  else child = startDetached(options)
  return waitForServer(options, current?.pid ?? old, child)
}

/**
 * The pid in `server.json` when it is a live server process of this data
 * folder that did not pass {@link runningServer}: a server from an older
 * build (no serverId, or the identity check before the HMAC proof), or null.
 */
function unprovenServerPid(dataDir: string): number | null {
  const discovery = readDiscovery(dataDir)
  if (!discovery || !processAlive(discovery.pid)) return null
  return isPiLabServerProcess(discovery.pid, dataDir) ? discovery.pid : null
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (processAlive(pid) && Date.now() < deadline) await delay(50)
  if (processAlive(pid)) process.kill(pid, "SIGKILL")
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The fatal error the starting server wrote, or null. */
function reportedStartError(dataDir: string): ServerStartError | null {
  const error = readFileSync(join(dataDir, SERVER_ERROR_FILE), "utf8").trim()
  return error ? (JSON.parse(error) as ServerStartError) : null
}

/**
 * Wait until a server other than `oldPid` with our build answers. Fails when
 * the server reports a start error, when its process exits (the detached
 * `child`, or the pid in its last start step under launchd), or when no new
 * start step comes for `options.noProgressMs`.
 */
async function waitForServer(
  options: LauncherOptions,
  oldPid: number | null,
  child: ChildProcess | null,
): Promise<ServerEndpoint> {
  const dataDir = options.config.dataDir
  let lastStep = ""
  let lastProgressAt = Date.now()
  while (true) {
    const error = reportedStartError(dataDir)
    if (error) throw new ServerStartFailure(error)
    const server = await runningServer(dataDir)
    if (server && server.pid !== oldPid && server.build === options.config.build) return server
    const progress = readStartProgress(dataDir)
    const step = progress ? `${progress.pid}:${progress.step}:${progress.at}` : ""
    if (step !== lastStep) {
      lastStep = step
      lastProgressAt = Date.now()
      if (progress) options.log(`[pi-lab] server ${progress.pid} start step: ${progress.step}`)
    }
    const childExited = child !== null && (child.exitCode !== null || child.signalCode !== null)
    if (childExited || (progress !== null && !processAlive(progress.pid))) {
      // It may have written its error just before exiting.
      const last = reportedStartError(dataDir)
      if (last) throw new ServerStartFailure(last)
      throw new ServerStartFailure({
        kind: "other",
        message: `The PI Lab server exited while starting.\n${serverLogTail(dataDir)}`,
      })
    }
    if (Date.now() - lastProgressAt > options.noProgressMs) {
      throw new ServerStartFailure({
        kind: "other",
        message: `The PI Lab server made no progress for ${options.noProgressMs / 1000} s while starting (last step: ${progress?.step ?? "none"}).\n${serverLogTail(dataDir)}`,
      })
    }
    await delay(100)
  }
}

/** The server could not start; carries what it reported. */
export class ServerStartFailure extends Error {
  constructor(readonly detail: ServerStartError) {
    super(detail.message)
    this.name = "ServerStartFailure"
  }
}

/**
 * Stop this data folder's server and wait for it to exit, before anything
 * moves its files (the Alpha new-build reset). Synchronous, because it runs
 * before Electron is ready.
 */
export function stopServerSync(dataDir: string, launchdLabel: string | null): void {
  const discovery = readDiscovery(dataDir)
  if (launchdLabel) launchctl(["bootout", `gui/${userInfo().uid}/${launchdLabel}`])
  if (!discovery || !processAlive(discovery.pid)) return
  // A crash can leave a pid that now belongs to another process.
  if (!isPiLabServerProcess(discovery.pid, dataDir)) {
    console.warn(`[pi-lab] pid ${discovery.pid} in server.json is not a PI Lab server; not stopped`)
    return
  }
  process.kill(discovery.pid, "SIGTERM")
  const pause = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + 10_000
  while (processAlive(discovery.pid) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 50)
  if (processAlive(discovery.pid)) {
    throw new Error(`The PI Lab server (pid ${discovery.pid}) did not stop`)
  }
}
