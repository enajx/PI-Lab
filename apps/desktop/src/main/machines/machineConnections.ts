import { createTRPCClient, createWSClient, wsLink } from "@trpc/client"
import { WebSocket } from "ws"
import { DEVICE_REVOKE_PATH, proveDeviceIdentity, TOKEN_HEADER } from "../../server/access"
import { SERVER_UPDATE_CAPABILITY } from "../../shared/clientApi"
import { compareVersions } from "../../shared/serverVersion"
import { readRemoteDiscovery, SshTunnel, type TunnelState } from "../server/tunnel"
import type { ServerRouter } from "../trpc/serverRouter"
import {
  type BehindPolicy,
  type LocalServerMode,
  readMachineFile,
  type StoredMachine,
  writeMachineFile,
} from "./machineStore"
import {
  bundleEnrollCommand,
  installServerBundle,
  openLocalNetworkAccess,
  probeRemote,
  type RemoteAccess,
  runRemote,
  SSH_TIMEOUT_MS,
  shellQuote,
} from "./remoteShell"
import type { ServerBundleFiles } from "./serverBundle"

export type { RemoteAccess }

/**
 * Connections from this app to remote PI Lab servers ("machines"). For each
 * stored machine: read the remote `server.json` over ssh, open an
 * {@link SshTunnel} to its port, check the identity proof keyed with this
 * app's device token for that machine, and give the renderer an endpoint.
 * The local server is not here: it stays with DesktopRuntime.
 */

/** The Stable app's data folder on the remote, relative to the remote home. */
export const DEFAULT_REMOTE_DATA_DIR = ".pi-lab"

/** Where "Add machine" installs the server bundle on the remote (install.sh `--prefix`). */
export const DEFAULT_REMOTE_SERVER_PREFIX = ".pi-lab/server"

/** The Stable desktop app on a remote Mac. */
export const DEFAULT_REMOTE_APP_PATH = "/Applications/PI Lab.app"

/** `enroll` of the Stable desktop app installed on the remote Mac, run by its own binary in Node mode. */
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
  /** The server version from its hello, once connected. */
  version: string | null
  /** The machine is older than the server bundle this app carries and can be updated over SSH (not with "Never"). */
  updateAvailable: boolean
  /** This app is installing its server bundle there now. */
  updating: boolean
  /** Why the last update over SSH failed, or null. */
  updateError: string | null
}

/** This device's machine settings (see {@link LocalServerMode}). */
export interface DeviceMachineSettings {
  localServer: LocalServerMode
  defaultMachine: string | null
  /** The multi-machine toggle; on while any machine is added. */
  multiMachine: boolean
}

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
  /** From the server's hello: its version, and whether it sends `server-update` (installed by install.sh). */
  version: string | null
  canUpdate: boolean
  update: Promise<void> | null
  updateError: string | null
  /** The bundle version an automatic update was last started for, so it runs once per bundle version. */
  autoUpdatedTo: string | null
}

const HELLO_TIMEOUT_MS = 15_000

/** The version and capabilities of the server behind a tunnel, from its hello. */
async function readHello(
  port: number,
  token: string,
): Promise<{ version: string; capabilities: string[] }> {
  const socket = createWSClient({
    url: `ws://127.0.0.1:${port}/trpc?token=${encodeURIComponent(token)}`,
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
  })
  const client = createTRPCClient<ServerRouter>({ links: [wsLink({ client: socket })] })
  const hello = await client.server.hello
    .query(undefined, { signal: AbortSignal.timeout(HELLO_TIMEOUT_MS) })
    .finally(() => socket.close())
  return { version: hello.version, capabilities: hello.capabilities }
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
  /** The local server's machine id (null: none ever ran), so the local server is not added as a machine. */
  localMachineId: () => Promise<string | null>
  /** The server bundle this app carries ("Add machine" installs it); null when it has none. */
  bundle: () => ServerBundleFiles | null
  log: (message: string) => void
}

export class MachineConnections {
  readonly #options: MachineConnectionsOptions
  readonly #machines = new Map<string, LiveMachine>()
  #behindPolicy: BehindPolicy
  #localServer: LocalServerMode
  #defaultMachine: string | null
  #multiMachine: boolean

  constructor(options: MachineConnectionsOptions) {
    this.#options = options
    const file = readMachineFile(options.profileDir)
    this.#behindPolicy = file.behindPolicy
    this.#localServer = file.localServer
    this.#defaultMachine = file.defaultMachine
    this.#multiMachine = file.multiMachine
    for (const stored of file.machines) {
      this.#machines.set(stored.machineId, this.#live(stored))
    }
  }

  /** "When a machine is behind this app" (see {@link BehindPolicy}). */
  behindPolicy(): BehindPolicy {
    return this.#behindPolicy
  }

  setBehindPolicy(policy: BehindPolicy): void {
    this.#behindPolicy = policy
    this.#save()
  }

  /** This device's "Local server" setting, default machine (null: this Mac) and multi-machine toggle, as saved. */
  deviceSettings(): DeviceMachineSettings {
    return {
      localServer: this.#localServer,
      defaultMachine: this.#defaultMachine,
      multiMachine: this.#multiMachine,
    }
  }

  /** Save the multi-machine toggle. Off is refused while any machine is added. */
  setMultiMachine(on: boolean): void {
    if (!on && this.#machines.size > 0) {
      throw new Error("Remove all machines before turning multi-machine off")
    }
    this.#multiMachine = on
    this.#save()
  }

  /** Save "Local server". Off needs a default machine other than this Mac. */
  setLocalServer(mode: LocalServerMode): void {
    if (mode === "off" && this.#defaultMachine === null) {
      throw new Error(
        "Choose another default machine than This Mac before turning the local server off",
      )
    }
    this.#localServer = mode
    this.#save()
  }

  /** Save the default machine (null: this Mac, refused while the local server is off). */
  setDefaultMachine(machineId: string | null): void {
    if (machineId === null && this.#localServer === "off") {
      throw new Error("This Mac cannot be the default machine while its local server is off")
    }
    if (machineId !== null && !this.#machines.has(machineId)) {
      throw new Error(`Machine ${machineId} is not added`)
    }
    this.#defaultMachine = machineId
    this.#save()
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
      version: live.version,
      updateAvailable: live.update === null && this.#behindPolicy !== "never" && this.#behind(live),
      updating: live.update !== null,
      updateError: live.updateError,
    }))
  }

  /**
   * Install the server bundle this app carries on a machine that is behind
   * (install.sh over SSH: only the server restarts, a failed start rolls
   * back), then connect again. One update at a time per machine.
   */
  update(machineId: string): Promise<void> {
    const live = this.#get(machineId)
    live.update ??= this.#install(live).finally(() => {
      live.update = null
    })
    return live.update
  }

  async #install(live: LiveMachine): Promise<void> {
    const bundle = this.#options.bundle()
    if (bundle === null) throw new Error("This app has no server bundle to install")
    if (!this.#behind(live)) throw new Error(`${live.stored.name} is not behind this app`)
    live.updateError = null
    this.#options.log(
      `[pi-lab] updating machine ${live.stored.name} from ${live.version} to ${bundle.version}`,
    )
    const installed = await installServerBundle(this.#options.access, live.stored.sshHost, bundle)
      .then(() => null)
      .catch((error: Error) => error)
    // Connect again either way: the new version, or the old one after the rollback.
    await this.#attempt(live).catch(() => undefined)
    if (installed !== null) {
      live.updateError = installed.message
      this.#options.log(`[pi-lab] machine ${live.stored.name}: ${installed.message}`)
      throw installed
    }
  }

  /** The machine sends `server-update` and is older than the bundle this app carries. */
  #behind(live: LiveMachine): boolean {
    const bundle = this.#options.bundle()
    return (
      live.canUpdate &&
      live.version !== null &&
      bundle !== null &&
      compareVersions(live.version, bundle.version) < 0
    )
  }

  /** With "Update automatically", update a machine that is behind, once per bundle version. */
  #autoUpdate(live: LiveMachine): void {
    const bundle = this.#options.bundle()
    if (this.#behindPolicy !== "auto" || bundle === null || !this.#behind(live)) return
    if (live.update !== null || live.autoUpdatedTo === bundle.version) return
    live.autoUpdatedTo = bundle.version
    void this.update(live.stored.machineId).catch(() => undefined)
  }

  #save(): void {
    writeMachineFile(this.#options.profileDir, {
      machines: [...this.#machines.values()].map((live) => live.stored),
      behindPolicy: this.#behindPolicy,
      localServer: this.#localServer,
      defaultMachine: this.#defaultMachine,
      multiMachine: this.#multiMachine,
    })
  }

  /**
   * The WebSocket URL (with this app's token) of a machine, asked by the
   * renderer on every connection attempt. Checks the identity over the tunnel
   * first; when the check fails (the remote server restarted on another
   * port), it reads the remote `server.json` again and opens a new tunnel.
   * Throws while the machine cannot be reached, so the socket retries.
   */
  async endpoint(machineId: string): Promise<{ url: string }> {
    const { port, token } = await this.httpEndpoint(machineId)
    return { url: `ws://127.0.0.1:${port}/trpc?token=${encodeURIComponent(token)}` }
  }

  /**
   * The tunnel's local port and this app's token for a machine, with the
   * same checks as {@link endpoint}: for plain HTTP to its server (report and
   * media streams, Download and Upload).
   */
  async httpEndpoint(machineId: string): Promise<{ port: number; token: string }> {
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
    return { port, token }
  }

  /**
   * Add a machine: probe `sshHost` over ssh. A running server (the desktop
   * app's or an installed bundle) is used; with none and no desktop app there,
   * this app's server bundle is copied over and installed (install.sh). Then
   * run `enroll`, store the device token and connect. Refuses a Linux remote,
   * the local server and a machine already added.
   */
  async add(input: { sshHost: string; name: string }): Promise<MachineSummary> {
    const { access, deviceName } = this.#options
    await openLocalNetworkAccess(access, input.sshHost)
    const probe = await probeRemote(access, input.sshHost)
    if (probe.system === "Linux") {
      throw new Error("Linux machines come in step 3 of multi-machine PI Lab")
    }
    if (probe.system !== "Darwin") {
      throw new Error(`${input.sshHost} runs ${probe.system}; only macOS is supported`)
    }
    let enrollCommand = access.enrollCommand
    if (probe.server === "bundle") enrollCommand = bundleEnrollCommand(access)
    if (probe.server === "none") {
      if (probe.appInstalled) {
        throw new Error(
          `PI Lab is installed on ${input.sshHost}, but its server is not running. Open PI Lab there once, then add the machine again.`,
        )
      }
      const bundle = this.#options.bundle()
      if (bundle === null) {
        throw new Error(
          `No PI Lab server runs on ${input.sshHost}, and this app has no server bundle to install there`,
        )
      }
      await installServerBundle(access, input.sshHost, bundle)
      enrollCommand = bundleEnrollCommand(access)
    }
    const enrolled = parseEnroll(
      await runRemote(
        access,
        input.sshHost,
        `${enrollCommand} --name ${shellQuote(deviceName)}`,
        null,
        SSH_TIMEOUT_MS,
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
    const live = this.#live(stored)
    this.#machines.set(stored.machineId, live)
    // Adding a machine turns multi-machine on (locked on while a machine is added).
    this.#multiMachine = true
    this.#save()
    await this.#attempt(live).catch(() => undefined)
    const summary = this.list().find((entry) => entry.machineId === stored.machineId)
    if (!summary) throw new Error("The added machine is missing")
    return summary
  }

  /**
   * Remove a machine: revoke this app's device on the remote when it can be
   * reached (after the identity check), close the tunnel, forget the token.
   * The last machine is refused while the local server is off.
   */
  async remove(machineId: string): Promise<{ revoked: boolean }> {
    const live = this.#get(machineId)
    if (this.#localServer === "off" && this.#machines.size === 1) {
      throw new Error("Turn the local server on before removing the last machine")
    }
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
    // The default moves to this Mac, or while the local server is off to another machine.
    if (this.#defaultMachine === machineId) {
      this.#defaultMachine =
        this.#localServer === "off" ? (this.#machines.keys().next().value ?? null) : null
    }
    this.#save()
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
      version: null,
      canUpdate: false,
      update: null,
      updateError: null,
      autoUpdatedTo: null,
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
    const hello = await readHello(tunnel.localPort, token).catch(async (error: Error) => {
      await tunnel?.close()
      return failed(new Error(`the PI Lab server on ${sshHost} did not answer: ${error.message}`))
    })
    if (live.stopped) {
      await tunnel.close()
      return
    }
    live.tunnel = tunnel
    live.state = "connected"
    live.error = null
    live.version = hello.version
    live.canUpdate = hello.capabilities.includes(SERVER_UPDATE_CAPABILITY)
    this.#autoUpdate(live)
  }
}
