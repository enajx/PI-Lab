import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { pathToFileURL } from "node:url"
import { firstFreePortInRange } from "@pi-lab/port-scanner"
import { net, protocol, session } from "electron"
import { isTestMode } from "../../../runtime/env"
import {
  type AnalysisInteractivePort,
  type AnalysisInteractiveResult,
  assertPathInside,
  buildMarimoLaunch,
  type OpenReportInput,
  releaseLeaseIfCurrent,
  removeIfCurrent,
  resolveReportAsset,
  type StartMarimoInput,
} from "./interactive"

const REPORT_SCHEME = "pi-lab-report"
const MARIMO_HOST = "127.0.0.1"
const START_TIMEOUT_MS = 15_000
const START_POLL_MS = 100
const STOP_GRACE_MS = 1_500
const STDERR_LIMIT = 16 * 1024

interface ReportGrant {
  ownerId: string
  root: string
}

interface ManagedMarimo {
  ownerId: string
  generation: number
  child: ChildProcess
  exited: Promise<void>
  stderr: string
  ended: boolean
}

/** Must run before `app.whenReady()` so Chromium treats report URLs as web origins. */
export function registerAnalysisReportScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: REPORT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

/**
 * Electron implementation of the interactive Analysis boundary. Report grants
 * are scoped to the selected report directory; marimo binds to loopback and is
 * launched in its own process group so route/app cleanup can reap descendants.
 */
export class AnalysisInteractiveController implements AnalysisInteractivePort {
  readonly #reportGrants = new Map<string, ReportGrant>()
  readonly #reportTokenByOwner = new Map<string, string>()
  readonly #marimoByOwner = new Map<string, ManagedMarimo>()
  readonly #generationByOwner = new Map<string, number>()
  readonly #leaseByOwner = new Map<string, string>()
  #protocolInstalled = false

  installProtocolHandler(): void {
    if (this.#protocolInstalled) return
    this.#protocolInstalled = true
    session.defaultSession.protocol.handle(REPORT_SCHEME, (request) =>
      this.#handleReportRequest(request),
    )
  }

  async begin(ownerId: string, leaseId: string): Promise<number> {
    const generation = this.#nextGeneration(ownerId)
    this.#leaseByOwner.set(ownerId, leaseId)
    await this.#release(ownerId)
    return generation
  }

  async openReport(input: OpenReportInput): Promise<AnalysisInteractiveResult> {
    this.#assertCurrent(input.ownerId, input.generation)
    const reportPath = await realpath(input.absPath)
    const repoPath = await realpath(input.repoPath)
    assertPathInside(repoPath, reportPath)
    if (!(await stat(reportPath)).isFile()) throw new Error("Interactive report must be a file")
    const root = await realpath(dirname(reportPath))
    this.#assertCurrent(input.ownerId, input.generation)
    const token = randomUUID()
    this.#reportGrants.set(token, { ownerId: input.ownerId, root })
    this.#reportTokenByOwner.set(input.ownerId, token)
    const entry = encodeURIComponent(basename(reportPath))
    return { type: "html", url: `${REPORT_SCHEME}://${token}/${entry}` }
  }

  async startMarimo(input: StartMarimoInput): Promise<AnalysisInteractiveResult> {
    this.#assertCurrent(input.ownerId, input.generation)
    const generation = input.generation
    const port = await firstFreePortInRange(input.portRange, MARIMO_HOST)
    if (port === undefined) {
      throw new Error(
        `No free port is available in ${input.portRange.start}–${input.portRange.end}`,
      )
    }
    this.#assertCurrent(input.ownerId, generation)

    const launch = this.#marimoLaunch(input, port)
    const child = spawn(launch.command, launch.args, {
      cwd: input.cwd,
      env: launch.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    })
    let resolveExited: () => void = () => {}
    const exited = new Promise<void>((resolveExit) => {
      resolveExited = resolveExit
    })
    let managed: ManagedMarimo
    managed = {
      ownerId: input.ownerId,
      generation,
      child,
      exited,
      stderr: "",
      ended: false,
    }
    child.once("exit", () => {
      managed.ended = true
      resolveExited()
    })
    child.once("error", (error) => {
      managed.stderr = error.message
      managed.ended = true
      resolveExited()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      managed.stderr = `${managed.stderr}${chunk.toString("utf8")}`.slice(-STDERR_LIMIT)
    })
    this.#marimoByOwner.set(input.ownerId, managed)

    const url = `http://${MARIMO_HOST}:${port}/`
    const ready = await this.#waitUntilReady(managed, url)
    if (!ready) {
      removeIfCurrent(this.#marimoByOwner, input.ownerId, managed)
      await terminateTree(managed)
      const detail = managed.stderr.trim()
      throw new Error(detail || "marimo exited before its notebook was ready")
    }
    if (this.#generationByOwner.get(input.ownerId) !== generation) {
      await terminateTree(managed)
      throw new Error("The marimo preview was closed while it was starting")
    }
    return { type: "marimo", url, runtime: input.runtime.displayName }
  }

  async close(ownerId: string, leaseId: string): Promise<void> {
    if (!releaseLeaseIfCurrent(this.#leaseByOwner, ownerId, leaseId)) return
    this.#nextGeneration(ownerId)
    await this.#release(ownerId)
  }

  async #release(ownerId: string): Promise<void> {
    const token = this.#reportTokenByOwner.get(ownerId)
    if (token) {
      this.#reportTokenByOwner.delete(ownerId)
      this.#reportGrants.delete(token)
    }
    const managed = this.#marimoByOwner.get(ownerId)
    if (!managed) return
    this.#marimoByOwner.delete(ownerId)
    await terminateTree(managed)
  }

  dispose(): void {
    this.#reportGrants.clear()
    this.#reportTokenByOwner.clear()
    this.#leaseByOwner.clear()
    for (const managed of this.#marimoByOwner.values()) {
      killTree(managed.child, "SIGKILL")
    }
    this.#marimoByOwner.clear()
  }

  #nextGeneration(ownerId: string): number {
    const next = (this.#generationByOwner.get(ownerId) ?? 0) + 1
    this.#generationByOwner.set(ownerId, next)
    return next
  }

  #assertCurrent(ownerId: string, generation: number): void {
    if (this.#generationByOwner.get(ownerId) !== generation) {
      throw new Error("The interactive preview was closed before it finished starting")
    }
  }

  #marimoLaunch(
    input: StartMarimoInput,
    port: number,
  ): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    const fixture = isTestMode ? process.env.PI_LAB_TEST_MARIMO_FIXTURE?.trim() : undefined
    if (fixture) {
      const marker = process.env.PI_LAB_TEST_MARIMO_MARKER?.trim() ?? ""
      return {
        command: process.execPath,
        args: [fixture, String(port), marker],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      }
    }
    const launch = buildMarimoLaunch(input.runtime, input.absPath, port)
    return { ...launch, env: { ...process.env } }
  }

  async #waitUntilReady(managed: ManagedMarimo, url: string): Promise<boolean> {
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (managed.ended) return false
      const reachable = await fetch(url)
        .then((response) => response.ok)
        .catch(() => false)
      if (reachable) return true
      await delay(START_POLL_MS)
    }
    managed.stderr = `${managed.stderr}\nTimed out waiting for marimo to start`.trim()
    return false
  }

  async #handleReportRequest(request: { url: string }): Promise<Response> {
    const url = new URL(request.url)
    const grant = this.#reportGrants.get(url.hostname)
    if (!grant) return new Response("Report preview expired", { status: 404 })
    let requested: string
    try {
      requested = decodeURIComponent(url.pathname.slice(1))
    } catch {
      return new Response("Invalid report path", { status: 400 })
    }
    if (!requested || requested.includes("\0")) {
      return new Response("Invalid report path", { status: 400 })
    }
    try {
      const canonical = await resolveReportAsset(grant.root, requested)
      return await net.fetch(pathToFileURL(canonical).toString())
    } catch {
      return new Response("Report asset not found", { status: 404 })
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function terminateTree(managed: ManagedMarimo): Promise<void> {
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
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ESRCH") throw error
  }
}
