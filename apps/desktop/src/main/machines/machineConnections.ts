import { spawn } from "node:child_process"
import { DEVICE_REVOKE_PATH, proveDeviceIdentity, TOKEN_HEADER } from "../../server/access"
import { readRemoteDiscovery, SshTunnel, type TunnelState } from "../server/tunnel"
import { readMachines, type StoredMachine, writeMachines } from "./machineStore"

/**
 * Connections from this app to remote PI Lab servers ("machines"). For each
 * stored machine: read the remote `server.json` over ssh, open an
 * {@link SshTunnel} to its port, check the identity proof keyed with this
 * app's device token for that machine, and give the renderer an endpoint.
 * The local server is not here: it stays with DesktopRuntime.
 */

/** How the app reaches remote servers. Production: the user's ssh, defaults below; tests point at a test sshd. */
export interface RemoteAccess {
  sshPath: string
  /** Extra ssh options placed before the host (tests only). */
  extraSshArgs: string[]
  /** The server's data folder on the remote machine; relative paths start at the remote home. */
  dataDir: string
  /** Shell command on the remote that runs `enroll` (without `--name`). */
  enrollCommand: string
}

/** The Stable app's data folder on the remote, relative to the remote home. */
export const DEFAULT_REMOTE_DATA_DIR = ".pi-lab"

/**
 * `enroll` of the Stable desktop app installed on the remote Mac, run by its
 * own binary in Node mode. Changes when the installer (PR 3) puts the server
 * bundle in place.
 */
export const DEFAULT_REMOTE_ENROLL_COMMAND =
  "ELECTRON_RUN_AS_NODE=1 '/Applications/PI Lab.app/Contents/MacOS/PI Lab' '/Applications/PI Lab.app/Contents/Resources/app.asar/out/main/enroll.js'"

/** connected: tunnel open and identity proven; offline: the last attempt failed or the machine was stopped. */
export type MachineState = "connecting" | "connected" | "reconnecting" | "offline"

/** What the renderer sees of a machine (never the token). */
export interface MachineSummary {
  machineId: string
  name: string
  sshHost: string
  addedAt: number
  state: MachineState
  /** Why the last attempt failed, or null. */
  error: string | null
}

const SSH_TIMEOUT_MS = 30_000
const REVOKE_TIMEOUT_MS = 5_000
/** An offline machine is tried again on an endpoint request at most this often. */
const RETRY_AFTER_MS = 10_000

interface LiveMachine {
  stored: StoredMachine
  tunnel: SshTunnel | null
  state: MachineState
  error: string | null
  attempt: Promise<void> | null
  failedAt: number
  /** Test seam: stopped by {@link MachineConnections.stopForTest}, no new attempt until started. */
  stopped: boolean
}

/** Quote one word for the remote POSIX shell. */
function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/** Run `command` on `host` over ssh; resolve with stdout, reject with stderr. */
async function runRemote(access: RemoteAccess, host: string, command: string): Promise<string> {
  const child = spawn(
    access.sshPath,
    ["-o", "BatchMode=yes", ...access.extraSshArgs, host, command],
    { stdio: ["ignore", "pipe", "pipe"] },
  )
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), SSH_TIMEOUT_MS)
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal }))
    },
  )
  clearTimeout(timer)
  const detail = stderr.trim()
  if (result.signal !== null) throw new Error(`ssh to ${host} timed out: ${detail}`)
  if (result.code === 255) throw new Error(`ssh to ${host} failed: ${detail}`)
  if (result.code !== 0) throw new Error(`${detail || `exit code ${result.code}`}`)
  return stdout
}

function parseEnroll(stdout: string): { machineId: string; deviceId: string; token: string } {
  const parsed: unknown = JSON.parse(stdout.trim().split("\n").at(-1) ?? "")
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("machineId" in parsed && typeof parsed.machineId === "string") ||
    !("deviceId" in parsed && typeof parsed.deviceId === "string") ||
    !("token" in parsed && typeof parsed.token === "string")
  ) {
    throw new Error("enroll printed no device token")
  }
  return { machineId: parsed.machineId, deviceId: parsed.deviceId, token: parsed.token }
}

export interface MachineConnectionsOptions {
  /** Electron's profile folder, where `machines.json` lives. */
  profileDir: string
  access: RemoteAccess
  /** This app's device name on remote servers. */
  deviceName: string
  /** The local server's machine id, so the local server is not added as a machine. */
  localMachineId: () => Promise<string>
  log: (message: string) => void
}

export class MachineConnections {
  readonly #options: MachineConnectionsOptions
  readonly #machines = new Map<string, LiveMachine>()

  constructor(options: MachineConnectionsOptions) {
    this.#options = options
    for (const stored of readMachines(options.profileDir)) {
      this.#machines.set(stored.machineId, this.#live(stored))
    }
  }

  /** Start connecting every stored machine; failures show as offline. */
  start(): void {
    for (const live of this.#machines.values()) void this.#attempt(live).catch(() => undefined)
  }

  list(): MachineSummary[] {
    return [...this.#machines.values()].map((live) => ({
      machineId: live.stored.machineId,
      name: live.stored.name,
      sshHost: live.stored.sshHost,
      addedAt: live.stored.addedAt,
      state: live.state,
      error: live.error,
    }))
  }

  /**
   * The WebSocket URL (with this app's token) of a machine, asked by the
   * renderer on every connection attempt. Checks the identity over the tunnel
   * first; when the check fails (the remote server restarted on another
   * port), it reads the remote `server.json` again and opens a new tunnel.
   * Throws while the machine cannot be reached, so the socket retries.
   */
  async endpoint(machineId: string): Promise<{ url: string }> {
    const live = this.#get(machineId)
    if (live.stopped) throw new Error(`${live.stored.name} is stopped`)
    if (live.attempt) await live.attempt
    else if (live.tunnel === null) {
      if (Date.now() - live.failedAt < RETRY_AFTER_MS) {
        throw new Error(live.error ?? `${live.stored.name} is offline`)
      }
      await this.#attempt(live)
    }
    const tunnel = live.tunnel
    if (tunnel === null || tunnel.state !== "open") {
      throw new Error(`${live.stored.name} is reconnecting`)
    }
    const { deviceId, token } = live.stored
    if (!(await proveDeviceIdentity(tunnel.localPort, deviceId, token))) {
      await this.#attempt(live)
    }
    const port = live.tunnel?.localPort
    if (port === undefined) throw new Error(live.error ?? `${live.stored.name} is offline`)
    return { url: `ws://127.0.0.1:${port}/trpc?token=${encodeURIComponent(token)}` }
  }

  /**
   * Add a machine: run `enroll` on `sshHost` over ssh, store the device token,
   * connect. Refuses a Linux remote, the local server and a machine already added.
   */
  async add(input: { sshHost: string; name: string }): Promise<MachineSummary> {
    const { access, deviceName } = this.#options
    const system = (await runRemote(access, input.sshHost, "uname -s")).trim()
    if (system === "Linux") throw new Error("Linux machines come in step 3 of multi-machine PI Lab")
    if (system !== "Darwin")
      throw new Error(`${input.sshHost} runs ${system}; only macOS is supported`)
    const enrolled = parseEnroll(
      await runRemote(
        access,
        input.sshHost,
        `${access.enrollCommand} --name ${shellQuote(deviceName)}`,
      ).catch((error: Error) => {
        throw new Error(`enroll on ${input.sshHost} failed: ${error.message}`)
      }),
    )
    if (enrolled.machineId === (await this.#options.localMachineId())) {
      throw new Error(`${input.sshHost} is this Mac's own server`)
    }
    if (this.#machines.has(enrolled.machineId)) {
      throw new Error(`${input.sshHost} is already added`)
    }
    const stored: StoredMachine = {
      machineId: enrolled.machineId,
      name: input.name,
      sshHost: input.sshHost,
      deviceId: enrolled.deviceId,
      token: enrolled.token,
      addedAt: Date.now(),
    }
    writeMachines(this.#options.profileDir, [
      ...[...this.#machines.values()].map((live) => live.stored),
      stored,
    ])
    const live = this.#live(stored)
    this.#machines.set(stored.machineId, live)
    await this.#attempt(live).catch(() => undefined)
    const summary = this.list().find((entry) => entry.machineId === stored.machineId)
    if (!summary) throw new Error("The added machine is missing")
    return summary
  }

  /**
   * Remove a machine: revoke this app's device on the remote when it can be
   * reached (after the identity check), close the tunnel, forget the token.
   */
  async remove(machineId: string): Promise<{ revoked: boolean }> {
    const live = this.#get(machineId)
    let revoked = false
    const tunnel = live.tunnel
    const { deviceId, token } = live.stored
    if (
      tunnel?.state === "open" &&
      (await proveDeviceIdentity(tunnel.localPort, deviceId, token))
    ) {
      const response = await fetch(`http://127.0.0.1:${tunnel.localPort}${DEVICE_REVOKE_PATH}`, {
        method: "POST",
        headers: { [TOKEN_HEADER]: token },
        redirect: "error",
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      }).catch((error: Error) => {
        this.#options.log(`[pi-lab] revoking on ${live.stored.sshHost} failed: ${error.message}`)
        return null
      })
      revoked = response?.status === 204
    }
    this.#machines.delete(machineId)
    writeMachines(
      this.#options.profileDir,
      [...this.#machines.values()].map((entry) => entry.stored),
    )
    live.stopped = true
    await tunnel?.close()
    return { revoked }
  }

  /** Test seam: close a machine's tunnel and refuse endpoints, as an unreachable machine. */
  async stopForTest(machineId: string): Promise<void> {
    const live = this.#get(machineId)
    live.stopped = true
    const tunnel = live.tunnel
    live.tunnel = null
    await tunnel?.close()
    live.state = "offline"
    live.error = "Stopped"
  }

  /** Test seam: undo {@link stopForTest}. */
  startForTest(machineId: string): void {
    const live = this.#get(machineId)
    live.stopped = false
    live.failedAt = 0
  }

  async close(): Promise<void> {
    for (const live of this.#machines.values()) live.stopped = true
    await Promise.all([...this.#machines.values()].map((live) => live.tunnel?.close()))
  }

  #live(stored: StoredMachine): LiveMachine {
    return {
      stored,
      tunnel: null,
      state: "offline",
      error: null,
      attempt: null,
      failedAt: 0,
      stopped: false,
    }
  }

  #get(machineId: string): LiveMachine {
    const live = this.#machines.get(machineId)
    if (!live) throw new Error(`No machine ${machineId}`)
    return live
  }

  /** One connection attempt at a time per machine; replaces any open tunnel. */
  #attempt(live: LiveMachine): Promise<void> {
    live.attempt ??= this.#open(live).finally(() => {
      live.attempt = null
    })
    return live.attempt
  }

  async #open(live: LiveMachine): Promise<void> {
    const { access, log } = this.#options
    const { sshHost, deviceId, token, name } = live.stored
    const old = live.tunnel
    live.tunnel = null
    await old?.close()
    live.state = "connecting"
    const failed = (error: Error): never => {
      live.state = "offline"
      live.error = error.message
      live.failedAt = Date.now()
      log(`[pi-lab] machine ${name} (${sshHost}): ${error.message}`)
      throw error
    }
    const discovery = await readRemoteDiscovery({
      sshPath: access.sshPath,
      host: sshHost,
      extraSshArgs: access.extraSshArgs,
      dataDir: access.dataDir,
      timeoutMs: SSH_TIMEOUT_MS,
    }).catch(failed)
    let tunnel: SshTunnel | null = null
    tunnel = await SshTunnel.open({
      host: sshHost,
      remotePort: discovery.port,
      sshPath: access.sshPath,
      extraSshArgs: access.extraSshArgs,
      serverAliveIntervalSeconds: 5,
      serverAliveCountMax: 3,
      openTimeoutMs: SSH_TIMEOUT_MS,
      backoff: { initialMs: 500, maxMs: 5_000 },
      onState: (state: TunnelState) => {
        if (tunnel === null || live.tunnel !== tunnel) return
        if (state === "reconnecting") live.state = "reconnecting"
        if (state === "open") live.state = "connected"
        if (state === "closed") live.state = "offline"
      },
      log,
    }).catch(failed)
    if (!(await proveDeviceIdentity(tunnel.localPort, deviceId, token))) {
      await tunnel.close()
      failed(
        new Error(
          `the PI Lab server on ${sshHost} does not accept this Mac's device token (it may have been revoked; remove and add the machine again)`,
        ),
      )
    }
    if (live.stopped) {
      await tunnel.close()
      return
    }
    live.tunnel = tunnel
    live.state = "connected"
    live.error = null
  }
}
