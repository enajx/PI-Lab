import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { isPortInUse } from "@pi-lab/port-scanner"
import { buildNotebookLaunch, NOTEBOOK_HOST, type NotebookLaunchInput } from "./notebookLaunch"

export interface StartNotebookInput extends Omit<NotebookLaunchInput, "port" | "token"> {
  /** Chosen by the renderer for its tab; stop and Open in browser name the server by it. */
  serverId: string
  /** Environment for the server process (PATH must reach uv for marimo's sandbox mode). */
  env: NodeJS.ProcessEnv
}

/**
 * App-lifetime owner of the marimo and Jupyter servers shown in notebook tabs. The
 * renderer only ever receives a URL; the processes stay here so a closed tab or a
 * quitting app can always stop them.
 */
export interface NotebookServerPort {
  start(input: StartNotebookInput): Promise<{ url: string }>
  /** Stop the server (also one still starting). Idempotent. */
  stop(serverId: string): Promise<void>
  /** The URL of a running server, or null. */
  urlOf(serverId: string): string | null
  /** Open a running server's notebook in the system browser. */
  openInBrowser(serverId: string): Promise<void>
  /** True when a notebook server (running or starting) uses this port. */
  servesPort(port: number): boolean
  /** Stop every server at once (app quit). */
  dispose(): void
}

interface ManagedServer {
  port: number
  child: ChildProcess
  exited: Promise<void>
  output: string
  ended: boolean
  ready: boolean
  stopped: boolean
  url: string
}

const OUTPUT_LIMIT = 16 * 1024
const STOP_GRACE_MS = 3_000

export class NotebookServers implements NotebookServerPort {
  readonly #servers = new Map<string, ManagedServer>()
  /** Servers stopped before they spawned; a tab's server id is never reused. */
  readonly #closed = new Set<string>()
  readonly #ports: { start: number; end: number }
  readonly #startTimeoutMs: number
  readonly #openUrl: (url: string) => Promise<void>

  /**
   * @param ports the port range servers are started on.
   * @param startTimeoutMs how long a server may take to print its URL (a first
   *   uvx run downloads the tool, which can take minutes).
   * @param openUrl opens a URL in the system browser (Electron's shell.openExternal).
   */
  constructor(
    ports: { start: number; end: number },
    startTimeoutMs: number,
    openUrl: (url: string) => Promise<void>,
  ) {
    this.#ports = ports
    this.#startTimeoutMs = startTimeoutMs
    this.#openUrl = openUrl
  }

  async start(input: StartNotebookInput): Promise<{ url: string }> {
    if (this.#servers.has(input.serverId)) throw new Error("This notebook server is already open")
    const port = await this.#freePort()
    if (this.#closed.has(input.serverId)) {
      throw new Error("The notebook was closed while its server was starting")
    }
    const token = randomBytes(24).toString("hex")
    const { serverId, env, ...launchInput } = input
    const launch = buildNotebookLaunch({ ...launchInput, port, token })
    const child = spawn(launch.command, launch.args, {
      cwd: input.cwd,
      env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let resolveExited: () => void = () => {}
    const exited = new Promise<void>((resolveExit) => {
      resolveExited = resolveExit
    })
    const managed: ManagedServer = {
      port,
      child,
      exited,
      output: "",
      ended: false,
      ready: false,
      stopped: false,
      url: launch.url,
    }
    this.#servers.set(serverId, managed)
    const printedUrl = new RegExp(`https?://(?:127\\.0\\.0\\.1|localhost):${port}\\b`)
    const readyOrEnded = new Promise<void>((resolveReady) => {
      const onOutput = (chunk: Buffer): void => {
        managed.output = `${managed.output}${chunk.toString("utf8")}`.slice(-OUTPUT_LIMIT)
        if (!managed.ready && printedUrl.test(managed.output)) {
          managed.ready = true
          resolveReady()
        }
      }
      child.stdout?.on("data", onOutput)
      child.stderr?.on("data", onOutput)
      void exited.then(resolveReady)
    })
    child.once("exit", () => {
      managed.ended = true
      resolveExited()
    })
    child.once("error", (error) => {
      managed.output = `${managed.output}\n${error.message}`
      managed.ended = true
      resolveExited()
    })

    // marimo's sandbox mode prints the URL before its server listens, so a printed
    // URL only counts once the server answers.
    const answering = readyOrEnded.then(() => waitUntilAnswering(managed, port))
    const timedOut = await Promise.race([
      answering.then(() => false),
      delay(this.#startTimeoutMs).then(() => true),
    ])
    if (managed.stopped) {
      throw new Error("The notebook was closed while its server was starting")
    }
    if (!managed.ready || managed.ended) {
      if (this.#servers.get(serverId) === managed) this.#servers.delete(serverId)
      await terminate(managed)
      const reason = timedOut
        ? `The notebook server did not start within ${Math.round(this.#startTimeoutMs / 1000)} seconds.`
        : "The notebook server stopped before it was ready."
      const detail = managed.output.trim()
      throw new Error(detail ? `${reason}\n${detail}` : reason)
    }
    return { url: launch.url }
  }

  async stop(serverId: string): Promise<void> {
    this.#closed.add(serverId)
    const managed = this.#servers.get(serverId)
    if (!managed) return
    this.#servers.delete(serverId)
    managed.stopped = true
    await terminate(managed)
  }

  urlOf(serverId: string): string | null {
    const managed = this.#servers.get(serverId)
    return managed?.ready && !managed.ended ? managed.url : null
  }

  servesPort(port: number): boolean {
    return [...this.#servers.values()].some((server) => server.port === port && !server.ended)
  }

  async openInBrowser(serverId: string): Promise<void> {
    const url = this.urlOf(serverId)
    if (!url) throw new Error("This notebook's server is not running")
    await this.#openUrl(url)
  }

  dispose(): void {
    for (const managed of this.#servers.values()) {
      managed.stopped = true
      killTree(managed.child, "SIGKILL")
    }
    this.#servers.clear()
  }

  async #freePort(): Promise<number> {
    const reserved = new Set([...this.#servers.values()].map((server) => server.port))
    for (let port = this.#ports.start; port <= this.#ports.end; port += 1) {
      if (reserved.has(port)) continue
      if (!(await isPortInUse(port, NOTEBOOK_HOST))) return port
    }
    throw new Error(
      `No free port is available for a notebook server in ${this.#ports.start}-${this.#ports.end}`,
    )
  }
}

const ANSWER_POLL_MS = 200

/** Poll the server's root until it answers, or until it ends. Marks it not ready if it ends. */
async function waitUntilAnswering(managed: ManagedServer, port: number): Promise<void> {
  while (managed.ready && !managed.ended && !managed.stopped) {
    const answered = await fetch(`http://${NOTEBOOK_HOST}:${port}/`, { redirect: "manual" }).then(
      () => true,
      () => false,
    )
    if (answered) return
    await delay(ANSWER_POLL_MS)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

/** SIGTERM the server's process group, then SIGKILL it if it is still running. */
async function terminate(managed: ManagedServer): Promise<void> {
  if (managed.ended) return
  killTree(managed.child, "SIGTERM")
  const graceful = await Promise.race([
    managed.exited.then(() => true),
    delay(STOP_GRACE_MS).then(() => false),
  ])
  if (!graceful) {
    killTree(managed.child, "SIGKILL")
    await managed.exited
  }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true })
    return
  }
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}
