import { spawn } from "node:child_process"
import { createReadStream, statSync } from "node:fs"
import { connect } from "node:net"
import { basename } from "node:path"
import type { ServerBundleFiles } from "./serverBundle"

/**
 * Commands this app runs on a remote machine over ssh: probe what PI Lab
 * runs there, copy this app's server bundle and run its installer.
 */

/** How the app reaches remote servers. Production: the user's ssh, defaults below; tests point at a test sshd. */
export interface RemoteAccess {
  sshPath: string
  /** Extra ssh options placed before the host (tests only). */
  extraSshArgs: string[]
  /** The server's data folder on the remote machine; relative paths start at the remote home. */
  dataDir: string
  /** Where install.sh puts the server bundle (`--prefix`); relative paths start at the remote home. */
  serverPrefix: string
  /** The desktop app on the remote; when it is there, its server is used, never the bundle. */
  appPath: string
  /** Shell command on the remote that runs the desktop app's `enroll` (without `--name`). */
  enrollCommand: string
  /** Extra install.sh options (tests: `--no-launchd`). */
  installArgs: string[]
  /** Environment for install.sh and the server it starts (tests: test mode). */
  installEnv: Record<string, string>
}

export const SSH_TIMEOUT_MS = 30_000
/** Unpacking the bundle and starting the server (install.sh waits up to 120 s for it). */
export const INSTALL_TIMEOUT_MS = 240_000

/** Quote one word for the remote POSIX shell. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/** How long the app's own connection to a machine may take before it is dropped. */
const LOCAL_NETWORK_TOUCH_MS = 3_000

/**
 * The address and port `ssh` would connect to for `host` (`ssh -G` reads the
 * config, no network), or null when ssh names none.
 */
export async function sshAddress(
  access: RemoteAccess,
  host: string,
): Promise<{ address: string; port: number } | null> {
  const config = await new Promise<string>((resolve, reject) => {
    const child = spawn(access.sshPath, [...access.extraSshArgs, "-G", host], {
      stdio: ["ignore", "pipe", "ignore"],
    })
    let out = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.once("error", reject)
    child.once("close", () => resolve(out))
  })
  const value = (key: string): string | null =>
    config.match(new RegExp(`^${key} (.+)$`, "m"))?.[1]?.trim() ?? null
  const address = value("hostname")
  const port = Number(value("port") ?? "22")
  if (address === null || !Number.isInteger(port)) return null
  return { address, port }
}

/**
 * Open and close one TCP connection from this app to the address `ssh` would
 * use for `host` ({@link sshAddress}). macOS asks for Local
 * Network access only when the app itself connects; until then the ssh it
 * starts fails with "No route to host". The result of the connection does not
 * matter, so it always resolves.
 */
export async function openLocalNetworkAccess(access: RemoteAccess, host: string): Promise<void> {
  const target = await sshAddress(access, host)
  if (target === null) return
  const { address, port } = target
  await new Promise<void>((resolve) => {
    const socket = connect({ host: address, port })
    const done = () => {
      socket.destroy()
      resolve()
    }
    socket.setTimeout(LOCAL_NETWORK_TOUCH_MS, done)
    socket.once("connect", done)
    socket.once("error", done)
  })
}

/** A file streamed to a remote command's stdin; `onSent` gets the size of each chunk handed to ssh. */
export interface RemoteInput {
  file: string
  onSent: (bytes: number) => void
}

/**
 * Run `command` on `host` over ssh; resolve with stdout, reject with stderr.
 * `stdin` is streamed to the command's stdin (null: no stdin). ssh is
 * stopped after `timeoutMs` without progress (no input sent, no output read).
 */
export async function runRemote(
  access: RemoteAccess,
  host: string,
  command: string,
  stdin: RemoteInput | null,
  timeoutMs: number,
): Promise<string> {
  const child = spawn(
    access.sshPath,
    ["-o", "BatchMode=yes", ...access.extraSshArgs, host, command],
    { stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"] },
  )
  let stdout = ""
  let stderr = ""
  // The time limit counts time without progress (input sent or output read),
  // so a large copy over a slow link is not killed while it moves.
  let timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
  const progress = () => {
    clearTimeout(timer)
    timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
  }
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString()
    progress()
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
    progress()
  })
  if (stdin !== null && child.stdin) {
    const input = createReadStream(stdin.file)
    input.on("data", (chunk: Buffer | string) => {
      progress()
      stdin.onSent(chunk.length)
    })
    // ssh can end before all input is sent (link dropped, timed out); its exit
    // below reports that, so the broken pipe is not an error of its own.
    child.stdin.on("error", () => input.destroy())
    input.pipe(child.stdin)
  }
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal }))
    },
  )
  clearTimeout(timer)
  const detail = stderr.trim()
  if (result.signal !== null) {
    throw new Error(`ssh to ${host} stopped: no progress for ${timeoutMs / 1000} s. ${detail}`)
  }
  if (result.code === 255) {
    // macOS answers this when PI Lab may not use the local network (ssh in Terminal still works).
    const hint = detail.includes("No route to host")
      ? " If ssh works in Terminal, allow PI Lab in System Settings > Privacy & Security > Local Network, then restart PI Lab."
      : ""
    throw new Error(`ssh to ${host} failed: ${detail}${hint}`)
  }
  if (result.code !== 0) throw new Error(`${detail || `exit code ${result.code}`}`)
  return stdout
}

/** What runs on a remote machine, from {@link probeRemote}. */
export interface RemoteProbe {
  /** `uname -s`. */
  system: string
  /** The live server on the data folder: one installed by install.sh, another one (the desktop app's), or none. */
  server: "bundle" | "app" | "none"
  /** The desktop app is installed at {@link RemoteAccess.appPath}. */
  appInstalled: boolean
}

/** Read the system, the live server on the data folder (server.json and its process) and the desktop app. */
export async function probeRemote(access: RemoteAccess, host: string): Promise<RemoteProbe> {
  const script = [
    `data=${shellQuote(access.dataDir)}`,
    `prefix=${shellQuote(access.serverPrefix)}`,
    'echo "system=$(uname -s)"',
    'pid=""',
    `if [ -f "$data/server.json" ]; then pid=$(sed -n 's/.*"pid":\\([0-9]*\\).*/\\1/p' "$data/server.json"); fi`,
    "server=none",
    'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then',
    '  command=$(ps -p "$pid" -o command= || true)',
    '  abs=$(cd "$prefix" 2>/dev/null && pwd -P || true)',
    '  if [ -n "$abs" ]; then case "$command" in "$abs"/versions/*) server=bundle ;; esac; fi',
    '  if [ "$server" = none ]; then case "$command" in */out/main/server.js*) server=app ;; esac; fi',
    "fi",
    'echo "server=$server"',
    `if [ -d ${shellQuote(access.appPath)} ]; then echo app=yes; else echo app=no; fi`,
  ].join("\n")
  const stdout = await runRemote(access, host, script, null, SSH_TIMEOUT_MS)
  const values = new Map(
    stdout
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=")
        return [line.slice(0, index), line.slice(index + 1)] as const
      }),
  )
  const server = values.get("server")
  const system = values.get("system")
  if (system === undefined || (server !== "bundle" && server !== "app" && server !== "none")) {
    throw new Error(`could not read what runs on ${host}: ${stdout.trim()}`)
  }
  return { system, server, appInstalled: values.get("app") === "yes" }
}

/** The remote command that runs `enroll` of the server installed by install.sh. */
export function bundleEnrollCommand(access: RemoteAccess): string {
  return `PI_LAB_DATA_DIR=${shellQuote(access.dataDir)} ${shellQuote(`${access.serverPrefix}/current/bin/pi-lab-server`)} enroll`
}

/**
 * Where "Add machine" or "Update" is: connecting (probe), copying the server
 * bundle (bytes handed to ssh of the bundle's three files), installing
 * (install.sh starts the server), enrolling (enroll and the first connection).
 */
export interface InstallProgress {
  step: "connecting" | "copying" | "installing" | "enrolling"
  /** Bytes of the bundle sent so far; 0 outside the copy. */
  sentBytes: number
  /** Size of the bundle's files; 0 outside the copy. */
  totalBytes: number
}

/**
 * Copy this app's server bundle to `host` over the ssh connection and run its
 * install.sh there (`--from-file`, the access prefix and data folder). Agents
 * keep running: install.sh restarts only the server. Rejects with the
 * installer's message when it fails (it rolls back itself). Reports the
 * copying (with bytes) and installing steps to `onProgress`.
 */
export async function installServerBundle(
  access: RemoteAccess,
  host: string,
  bundle: ServerBundleFiles,
  onProgress: (progress: InstallProgress) => void,
): Promise<void> {
  const dir = (await runRemote(access, host, "mktemp -d", null, SSH_TIMEOUT_MS)).trim()
  if (!dir.startsWith("/")) throw new Error(`mktemp on ${host} gave ${dir}`)
  const remote = (file: string) => `${dir}/${basename(file)}`
  const files = [bundle.tarball, bundle.sha256File, bundle.installer]
  const totalBytes = files.map((file) => statSync(file).size).reduce((sum, size) => sum + size, 0)
  let sentBytes = 0
  onProgress({ step: "copying", sentBytes, totalBytes })
  const onSent = (bytes: number) => {
    sentBytes += bytes
    onProgress({ step: "copying", sentBytes, totalBytes })
  }
  for (const file of files) {
    await runRemote(
      access,
      host,
      `cat > ${shellQuote(remote(file))}`,
      { file, onSent },
      INSTALL_TIMEOUT_MS,
    )
  }
  onProgress({ step: "installing", sentBytes: 0, totalBytes: 0 })
  const env = Object.entries(access.installEnv)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ")
  const install = [
    ...(env ? [env] : []),
    "/bin/sh",
    shellQuote(remote(bundle.installer)),
    "--from-file",
    shellQuote(remote(bundle.tarball)),
    "--prefix",
    shellQuote(access.serverPrefix),
    "--data-dir",
    shellQuote(access.dataDir),
    ...access.installArgs.map(shellQuote),
  ].join(" ")
  const result = await runRemote(
    access,
    host,
    `${install}; code=$?; rm -rf ${shellQuote(dir)}; exit $code`,
    null,
    INSTALL_TIMEOUT_MS,
  ).catch((error: Error) => {
    throw new Error(`installing the PI Lab server on ${host} failed: ${error.message}`)
  })
  if (!result.includes(`"version":"${bundle.version}"`)) {
    throw new Error(`the installer on ${host} did not report version ${bundle.version}`)
  }
}
