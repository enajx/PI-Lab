import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import {
  readDiscovery,
  readLocalToken,
  type ServerDiscovery,
  TOKEN_HEADER,
} from "../../server/access"
import { type ServerConfig, serverConfigEnv } from "../../server/config"

/** Where the desktop app finds its server and how it authenticates. */
export interface ServerEndpoint {
  port: number
  pid: number
  token: string
  build: string
}

/** How this app instance runs its server. */
export interface LauncherOptions {
  config: ServerConfig
  /** Absolute path of `out/main/server.js`. */
  serverEntry: string
  /** launchd label for packaged builds; null starts a detached child process instead. */
  launchdLabel: string | null
  log: (message: string) => void
}

/** A fatal start error the server wrote before exiting (see server/index.ts). */
export interface ServerStartError {
  kind: "migration" | "other"
  message: string
}

export const SERVER_ERROR_FILE = "server-error.json"
export const SERVER_LOG_FILE = "server.log"
const START_TIMEOUT_MS = 30_000

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

/** True when the server at `discovery` answers its health check with our token. */
async function healthy(discovery: ServerDiscovery, token: string): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${discovery.port}/health`, {
    headers: { [TOKEN_HEADER]: token },
    signal: AbortSignal.timeout(2_000),
  }).catch(() => null)
  return response?.ok === true
}

/** The running server for this data folder, if it answers. */
async function runningServer(dataDir: string): Promise<ServerEndpoint | null> {
  const discovery = readDiscovery(dataDir)
  const token = readLocalToken(dataDir)
  if (!discovery || !token || !processAlive(discovery.pid)) return null
  if (!(await healthy(discovery, token))) return null
  return { port: discovery.port, pid: discovery.pid, token, build: discovery.build }
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
function startDetached(options: LauncherOptions): void {
  const log = openSync(join(options.config.dataDir, SERVER_LOG_FILE), "a")
  const child = spawn(process.execPath, [options.serverEntry], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, ...serverConfigEnv(options.config), ELECTRON_RUN_AS_NODE: "1" },
  })
  child.unref()
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
  if (current) {
    // A clean exit is not restarted by launchd, so the new definition starts next.
    options.log(`[pi-lab] restarting server ${current.pid}: build ${current.build} differs`)
    stopByPid(current.pid)
    await waitForExit(current.pid)
  }
  writeFileSync(join(dataDir, SERVER_ERROR_FILE), "", { flag: "w" })
  if (options.launchdLabel) startWithLaunchd(options)
  else startDetached(options)
  return waitForServer(options, current?.pid ?? null)
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (processAlive(pid) && Date.now() < deadline) await delay(50)
  if (processAlive(pid)) process.kill(pid, "SIGKILL")
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Wait until a server other than `oldPid` with our build answers. */
async function waitForServer(
  options: LauncherOptions,
  oldPid: number | null,
): Promise<ServerEndpoint> {
  const dataDir = options.config.dataDir
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const error = readFileSync(join(dataDir, SERVER_ERROR_FILE), "utf8").trim()
    if (error) throw new ServerStartFailure(JSON.parse(error) as ServerStartError)
    const server = await runningServer(dataDir)
    if (server && server.pid !== oldPid && server.build === options.config.build) return server
    await delay(100)
  }
  throw new ServerStartFailure({
    kind: "other",
    message: `The PI Lab server did not start within ${START_TIMEOUT_MS / 1000} s.\n${serverLogTail(dataDir)}`,
  })
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
  process.kill(discovery.pid, "SIGTERM")
  const pause = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + 10_000
  while (processAlive(discovery.pid) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 50)
  if (processAlive(discovery.pid)) {
    throw new Error(`The PI Lab server (pid ${discovery.pid}) did not stop`)
  }
}
