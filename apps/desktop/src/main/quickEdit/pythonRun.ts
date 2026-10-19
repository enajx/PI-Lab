import { realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import { type DaemonClient, DaemonError } from "@pi-lab/pty-daemon"
import {
  environmentDirForInterpreter,
  inspectPythonRuntime,
  type PythonProbe,
  type PythonRuntime,
  type PythonRuntimeResolver,
  resolveWorkspacePythonRuntime,
} from "../python"
import type { PythonStandaloneDiscoverer } from "../python/standaloneInterpreters"

export interface QuickPythonEnvironmentOption {
  path: string
  displayName: string
  interpreterPath: string
}

interface QuickPythonPorts {
  resolveRuntime: PythonRuntimeResolver
  discoverStandalonePython: PythonStandaloneDiscoverer
  projectRootForFile?: (filePath: string) => Promise<string | null>
  probeRuntime: PythonProbe
  getDaemonClient: () => Promise<DaemonClient>
}

/** Python actions for a quick-opened file, with its registered project when present. */
export class QuickPythonRunner {
  private readonly selectedByFolder = new Map<string, string>()
  private readonly sessions = new Set<string>()

  constructor(private readonly ports: QuickPythonPorts) {}

  /** Find this file's environment and standalone Python versions when the picker opens. */
  async options(filePath: string): Promise<{
    runtime: PythonRuntime
    options: QuickPythonEnvironmentOption[]
  }> {
    const folder = await this.fileFolder(filePath)
    const workspace = (await this.ports.projectRootForFile?.(filePath)) ?? folder
    const selected = this.selectedByFolder.get(folder) ?? null
    const runtime = await inspectPythonRuntime(
      await resolveWorkspacePythonRuntime(this.ports.resolveRuntime, workspace, selected),
      folder,
      this.ports.probeRuntime,
    )
    const candidatePaths = [join(workspace, ".venv"), join(workspace, "venv")]
    if (runtime.source !== null && runtime.interpreterPath) {
      candidatePaths.unshift(selected ?? environmentDirForInterpreter(runtime.interpreterPath))
    }
    const result: QuickPythonEnvironmentOption[] = []
    const seen = new Set<string>()
    for (const path of candidatePaths) {
      await this.addOption(workspace, path, seen, result)
    }
    for (const candidate of await this.ports.discoverStandalonePython(folder)) {
      if (seen.has(candidate.path)) continue
      seen.add(candidate.path)
      result.push({
        path: candidate.path,
        displayName: candidate.displayName,
        interpreterPath: candidate.path,
      })
    }
    return { runtime, options: result }
  }

  /** Keep a manual environment choice for this app session and folder. */
  async select(filePath: string, path: string | null): Promise<PythonRuntime> {
    const folder = await this.fileFolder(filePath)
    const workspace = (await this.ports.projectRootForFile?.(filePath)) ?? folder
    if (path === null) {
      this.selectedByFolder.delete(folder)
      return inspectPythonRuntime(
        await this.ports.resolveRuntime(workspace, null),
        folder,
        this.ports.probeRuntime,
      )
    }
    if (!isAbsolute(path)) throw new Error("Python environment selection must be an absolute path")
    const runtime = await this.ports.resolveRuntime(workspace, path)
    if (runtime.source !== "selected") {
      throw new Error("The selected path is not a working Python environment or interpreter")
    }
    this.selectedByFolder.set(folder, path)
    return inspectPythonRuntime(runtime, folder, this.ports.probeRuntime)
  }

  /** Run the disk copy of a Python file in its own folder through the shared PTY daemon. */
  async run(
    filePath: string,
    cols: number,
    rows: number,
  ): Promise<{ sessionId: string; runtime: PythonRuntime }> {
    const folder = await this.fileFolder(filePath)
    const workspace = (await this.ports.projectRootForFile?.(filePath)) ?? folder
    if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
      throw new Error("Invalid terminal size")
    }
    const runtime = await resolveWorkspacePythonRuntime(
      this.ports.resolveRuntime,
      workspace,
      this.selectedByFolder.get(folder) ?? null,
    )
    const command = runtime.runStrategy.command
    if (!command) throw new Error("No Python interpreter or uv runtime is available")
    const client = await this.ports.getDaemonClient()
    const session = await client.spawn({
      command,
      args: [...runtime.runStrategy.argsPrefix, basename(filePath)],
      cwd: folder,
      cols,
      rows,
    })
    this.sessions.add(session.id)
    return { sessionId: session.id, runtime }
  }

  /** Stop a process owned by this runner when its quick terminal closes. */
  async kill(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) throw new Error("Unknown quick Python session")
    const client = await this.ports.getDaemonClient()
    await client.kill(sessionId).catch((cause: unknown) => {
      if (!(cause instanceof DaemonError) || cause.code !== "unknown-session") throw cause
    })
    this.sessions.delete(sessionId)
  }

  private async fileFolder(filePath: string): Promise<string> {
    if (!/\.py$/i.test(filePath)) throw new Error("Run Python requires a Python file")
    const canonical = await realpath(filePath)
    if (!(await stat(canonical)).isFile()) throw new Error("Run Python requires a regular file")
    return dirname(canonical)
  }

  private async addOption(
    folder: string,
    path: string,
    seen: Set<string>,
    result: QuickPythonEnvironmentOption[],
  ): Promise<void> {
    const runtime = await this.ports.resolveRuntime(folder, path)
    if (runtime.source !== "selected" || !runtime.interpreterPath) return
    const canonical = await realpath(runtime.interpreterPath).then(
      (value) => value,
      () => null,
    )
    if (!canonical || seen.has(canonical)) return
    seen.add(canonical)
    result.push({
      path,
      displayName: runtime.displayName,
      interpreterPath: runtime.interpreterPath,
    })
  }
}
