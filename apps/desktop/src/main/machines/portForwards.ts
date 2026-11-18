import { SshTunnel } from "../server/tunnel"
import { type RemoteAccess, SSH_TIMEOUT_MS } from "./remoteShell"

/**
 * Local ports forwarded to a port on a remote machine's 127.0.0.1, for the
 * notebook and marimo servers a remote PI Lab server starts (their pages show
 * in frames here). One {@link SshTunnel} per machine and remote port, opened
 * on first use and kept until the app quits (notebook servers reuse ports).
 */
export class PortForwards {
  readonly #access: RemoteAccess
  readonly #sshHost: (machineId: string) => string
  readonly #log: (message: string) => void
  readonly #tunnels = new Map<string, Promise<SshTunnel>>()
  /** Local ports of open forwards, for the notebook frame rules (notebookFrames.ts). */
  readonly #localPorts = new Set<number>()

  constructor(
    access: RemoteAccess,
    sshHost: (machineId: string) => string,
    log: (message: string) => void,
  ) {
    this.#access = access
    this.#sshHost = sshHost
    this.#log = log
  }

  /** The local port that reaches `remotePort` on the machine; opens the forward on first use. */
  async localPort(machineId: string, remotePort: number): Promise<number> {
    const key = `${machineId}:${remotePort}`
    let tunnel = this.#tunnels.get(key)
    if (!tunnel) {
      tunnel = this.#open(machineId, remotePort)
      this.#tunnels.set(key, tunnel)
      // A failed open is tried again on the next ask.
      tunnel.catch(() => this.#tunnels.delete(key))
    }
    const open = await tunnel
    if (open.state === "closed") {
      this.#tunnels.delete(key)
      return this.localPort(machineId, remotePort)
    }
    return open.localPort
  }

  /** True when `port` is the local end of a forward. */
  isForwarded(port: number): boolean {
    return this.#localPorts.has(port)
  }

  async close(): Promise<void> {
    const tunnels = [...this.#tunnels.values()]
    this.#tunnels.clear()
    await Promise.all(
      tunnels.map((tunnel) => tunnel.then((open) => open.close()).catch(() => undefined)),
    )
  }

  async #open(machineId: string, remotePort: number): Promise<SshTunnel> {
    let localPort: number | null = null
    const tunnel = await SshTunnel.open({
      host: this.#sshHost(machineId),
      remotePort,
      sshPath: this.#access.sshPath,
      extraSshArgs: this.#access.extraSshArgs,
      serverAliveIntervalSeconds: 5,
      serverAliveCountMax: 3,
      openTimeoutMs: SSH_TIMEOUT_MS,
      backoff: { initialMs: 500, maxMs: 5_000 },
      onState: (state, port) => {
        if (localPort !== null) this.#localPorts.delete(localPort)
        localPort = port
        if (state !== "closed") this.#localPorts.add(port)
      },
      log: this.#log,
    })
    return tunnel
  }
}
