import { randomBytes } from "node:crypto"
import { isPortInUse } from "@pi-lab/port-scanner"
import { ProcessGroup } from "../runtime/processGroup"
import { buildNotebookLaunch, NOTEBOOK_HOST, type NotebookLaunchInput } from "./notebookLaunch"

export interface StartNotebookInput
  extends Omit<NotebookLaunchInput, "port" | "token" | "devServerOrigin"> {
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
  /** How many servers run or start (the quit dialog names them). */
  runningCount(): number
  /**
   * Stop every server (SIGTERM, then SIGKILL after a grace) and cancel starts in
   * progress: the window reloaded or closed, or PI Lab quits.
   */
  stopAll(): Promise<void>
  /**
   * Last call at app exit: SIGTERM every server and refuse new starts. The process
   * group watcher sends SIGKILL after a grace once PI Lab has exited.
   */
  dispose(): void
}

interface ManagedServer {
  port: number
  group: ProcessGroup
  output: string
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
  readonly #devServerOrigin: string | null
  readonly #openUrl: (url: string) => Promise<void>
  /** Raised by stopAll and dispose; a start that sees it change spawns nothing. */
  #generation = 0
  #disposed = false

  /**
   * @param ports the port range servers are started on.
   * @param startTimeoutMs how long a server may take to print its URL and answer
   *   (a first uvx run downloads the tool, which can take minutes).
   * @param devServerOrigin the renderer's dev server origin, which may show Jupyter
   *   in a frame besides the packaged `file:` page; null in a packaged build.
   * @param openUrl opens a URL in the system browser (Electron's shell.openExternal).
   */
  constructor(
    ports: { start: number; end: number },
    startTimeoutMs: number,
    devServerOrigin: string | null,
    openUrl: (url: string) => Promise<void>,
  ) {
    this.#ports = ports
    this.#startTimeoutMs = startTimeoutMs
    this.#devServerOrigin = devServerOrigin
    this.#openUrl = openUrl
  }

  async start(input: StartNotebookInput): Promise<{ url: string }> {
    if (this.#servers.has(input.serverId)) throw new Error("This notebook server is already open")
    const generation = this.#generation
    const cancelled = (): boolean =>
      this.#disposed || generation !== this.#generation || this.#closed.has(input.serverId)
    if (cancelled()) throw new Error("The notebook was closed while its server was starting")
    const port = await this.#freePort()
    if (cancelled()) throw new Error("The notebook was closed while its server was starting")
    const token = randomBytes(24).toString("hex")
    const { serverId, env, ...launchInput } = input
    const launch = buildNotebookLaunch({
      ...launchInput,
      port,
      token,
      devServerOrigin: this.#devServerOrigin,
    })
    const group = new ProcessGroup(launch.command, launch.args, { cwd: input.cwd, env })
    const child = group.child
    const managed: ManagedServer = {
      port,
      group,
      output: "",
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
      child.stdout.on("data", onOutput)
      child.stderr.on("data", onOutput)
      void group.exited.then(resolveReady)
    })
    child.once("error", (error) => {
      managed.output = `${managed.output}\n${error.message}`
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
    // A printed URL is not enough: the server must also answer before the timeout.
    if (timedOut || !managed.ready || group.ended) {
      managed.stopped = true
      if (this.#servers.get(serverId) === managed) this.#servers.delete(serverId)
      await group.stop(STOP_GRACE_MS)
      const reason = timedOut
        ? managed.ready
          ? `The notebook server printed its address but did not start within ${Math.round(this.#startTimeoutMs / 1000)} seconds.`
          : `The notebook server did not start within ${Math.round(this.#startTimeoutMs / 1000)} seconds.`
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
    await managed.group.stop(STOP_GRACE_MS)
  }

  urlOf(serverId: string): string | null {
    const managed = this.#servers.get(serverId)
    return managed?.ready && !managed.group.ended ? managed.url : null
  }

  servesPort(port: number): boolean {
    return [...this.#servers.values()].some((server) => server.port === port && !server.group.ended)
  }

  runningCount(): number {
    return [...this.#servers.values()].filter((server) => !server.group.ended).length
  }

  async openInBrowser(serverId: string): Promise<void> {
    const url = this.urlOf(serverId)
    if (!url) throw new Error("This notebook's server is not running")
    await this.#openUrl(url)
  }

  async stopAll(): Promise<void> {
    this.#generation += 1
    const running = [...this.#servers.values()]
    this.#servers.clear()
    await Promise.all(
      running.map((managed) => {
        managed.stopped = true
        return managed.group.stop(STOP_GRACE_MS)
      }),
    )
  }

  dispose(): void {
    this.#disposed = true
    this.#generation += 1
    for (const managed of this.#servers.values()) {
      managed.stopped = true
      managed.group.signal("SIGTERM")
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
  while (managed.ready && !managed.group.ended && !managed.stopped) {
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

/** The events of a BrowserWindow and its webContents that {@link stopNotebooksWithWindow} uses. */
interface WindowEvents {
  on(event: "closed", listener: () => void): unknown
}
interface WindowContentsEvents {
  on(
    event: "did-start-navigation",
    listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
  ): unknown
  on(event: "render-process-gone", listener: () => void): unknown
}

/**
 * The notebook tabs live in the window's page, so stop every server when that page
 * goes away: a new main-frame page load (reload, or a switch to the quick editor),
 * a renderer crash, or the window closing (also when PI Lab moves to the
 * background). A frame's own navigation (a notebook page loading) does not count.
 */
export function stopNotebooksWithWindow(
  window: WindowEvents,
  contents: WindowContentsEvents,
  stopAll: () => Promise<void>,
): void {
  const stop = (): void => {
    stopAll().catch((error: unknown) => {
      console.error("[pi-lab] could not stop the notebook servers", error)
    })
  }
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) stop()
  })
  contents.on("render-process-gone", stop)
  window.on("closed", stop)
}
