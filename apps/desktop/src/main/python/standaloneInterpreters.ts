import { execFile } from "node:child_process"
import { readdir, realpath } from "node:fs/promises"
import { posix, win32 } from "node:path"
import type { PythonProbe } from "./runtime"

export interface PythonStandaloneInterpreterCandidate {
  /** Canonical interpreter executable, suitable for a manual picker selection. */
  path: string
  displayName: string
  version: string
}

export type PythonStandaloneDiscoverer = (
  cwd: string,
) => Promise<PythonStandaloneInterpreterCandidate[]>

export interface PythonStandaloneDirectoryEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

export interface PythonStandaloneDiscoveryFileSystem {
  readDirectory: (path: string) => Promise<PythonStandaloneDirectoryEntry[]>
  realPath: (path: string) => Promise<string>
}

export interface PythonStandaloneDiscoveryOptions {
  platform: NodeJS.Platform
  terminalPath: string
  cwd: string
  probe: PythonProbe
  fileSystem?: PythonStandaloneDiscoveryFileSystem
}

const PROBE_TIMEOUT_MS = 3_000
const PYTHON_INFO_SCRIPT =
  "import json,os,sys; print(json.dumps({'executable':sys.executable,'version':f'{sys.version_info.major}.{sys.version_info.minor}','isVenv':sys.prefix != sys.base_prefix,'isConda':os.path.isdir(os.path.join(sys.prefix,'conda-meta'))}))"
const MAC_HOMEBREW_OPT_ROOTS = ["/opt/homebrew/opt", "/usr/local/opt"]
const MAC_PYTHON_ORG_VERSIONS = "/Library/Frameworks/Python.framework/Versions"

/**
 * Discover installed Python interpreters only when the Quick Editor picker
 * opens. A login shell supplies PATH, while conventional macOS installations
 * are included even when their bin folders are absent from PATH.
 */
export const liveStandalonePythonDiscoverer: PythonStandaloneDiscoverer = async (cwd) => {
  let environment: NodeJS.ProcessEnv = process.env
  if (process.platform !== "win32") {
    const { liveAgentLaunchEnvironment } = await import("../agents/executable")
    environment = (await liveAgentLaunchEnvironment().catch(() => null)) ?? environment
  }
  return discoverStandalonePythonInterpreters({
    platform: process.platform,
    terminalPath: environment.PATH ?? "",
    cwd,
    probe: probeWithEnvironment(environment),
  })
}

/** Return a bounded set of executable folders without searching recursively. */
export function standalonePythonSearchDirectories(
  platform: NodeJS.Platform,
  terminalPath: string,
): string[] {
  const paths = platform === "win32" ? win32 : posix
  const separator = platform === "win32" ? ";" : ":"
  const result: string[] = []
  const seen = new Set<string>()
  for (const rawPath of terminalPath.split(separator)) {
    if (!paths.isAbsolute(rawPath)) continue
    const normalized = paths.normalize(rawPath)
    const key = platform === "win32" ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  if (platform === "darwin") {
    for (const directory of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      if (seen.has(directory)) continue
      seen.add(directory)
      result.push(directory)
    }
  }
  return result
}

/** Validate PATH and standard-install candidates without creating an environment. */
export async function discoverStandalonePythonInterpreters(
  options: PythonStandaloneDiscoveryOptions,
): Promise<PythonStandaloneInterpreterCandidate[]> {
  const paths = options.platform === "win32" ? win32 : posix
  const fileSystem = options.fileSystem ?? liveDiscoveryFileSystem
  const directories = standalonePythonSearchDirectories(options.platform, options.terminalPath)
  if (options.platform === "darwin") {
    for (const root of MAC_HOMEBREW_OPT_ROOTS) {
      for (const entry of await availableEntries(fileSystem, root)) {
        if ((entry.isDirectory || entry.isSymbolicLink) && /^python@3\.\d+$/.test(entry.name)) {
          directories.push(paths.join(root, entry.name, "bin"))
        }
      }
    }
    for (const entry of await availableEntries(fileSystem, MAC_PYTHON_ORG_VERSIONS)) {
      if ((entry.isDirectory || entry.isSymbolicLink) && /^3\.\d+$/.test(entry.name)) {
        directories.push(paths.join(MAC_PYTHON_ORG_VERSIONS, entry.name, "bin"))
      }
    }
  }

  const choices: PythonStandaloneInterpreterCandidate[] = []
  const seenPaths = new Set<string>()
  const seenInterpreters = new Set<string>()
  for (const directory of directories) {
    for (const entry of await availableEntries(fileSystem, directory)) {
      if (
        (!entry.isFile && !entry.isSymbolicLink) ||
        !isPythonExecutable(entry.name, options.platform)
      ) {
        continue
      }
      const path = paths.join(directory, entry.name)
      if (seenPaths.has(path)) continue
      seenPaths.add(path)
      const result = await options.probe({
        command: path,
        args: ["-c", PYTHON_INFO_SCRIPT],
        cwd: options.cwd,
        timeoutMs: PROBE_TIMEOUT_MS,
      })
      if (result.notFound || result.timedOut || result.code !== 0) continue
      const info = parsePythonInfo(result.stdout)
      if (!info || info.isVenv || info.isConda || !paths.isAbsolute(info.executable)) continue
      const canonical = await fileSystem.realPath(info.executable).then(
        (value) => value,
        () => null,
      )
      if (!canonical || seenInterpreters.has(canonical)) continue
      seenInterpreters.add(canonical)
      choices.push({
        path: canonical,
        displayName: `Python ${info.version}`,
        version: info.version,
      })
    }
  }
  return choices
}

const liveDiscoveryFileSystem: PythonStandaloneDiscoveryFileSystem = {
  readDirectory: async (path) =>
    (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    })),
  realPath: realpath,
}

/** Probe shell shims with the same PATH and manager variables as the terminal. */
function probeWithEnvironment(environment: NodeJS.ProcessEnv): PythonProbe {
  return ({ command, args, cwd, timeoutMs }) =>
    new Promise((resolveProbe) => {
      execFile(
        command,
        [...args],
        { cwd, env: environment, timeout: timeoutMs, maxBuffer: 64 * 1024 },
        (error, stdout, stderr) => {
          const code =
            typeof (error as NodeJS.ErrnoException | null)?.code === "number"
              ? ((error as unknown as { code: number }).code ?? null)
              : error
                ? null
                : 0
          const errorCode = (error as NodeJS.ErrnoException | null)?.code
          resolveProbe({
            stdout,
            stderr,
            code,
            notFound: errorCode === "ENOENT",
            timedOut:
              Boolean((error as { killed?: boolean } | null)?.killed) || errorCode === "ETIMEDOUT",
          })
        },
      )
    })
}

async function availableEntries(
  fileSystem: PythonStandaloneDiscoveryFileSystem,
  path: string,
): Promise<PythonStandaloneDirectoryEntry[]> {
  return fileSystem.readDirectory(path).catch((cause: unknown) => {
    if (isExpectedUnavailableDirectory(cause)) return []
    throw cause
  })
}

function isPythonExecutable(name: string, platform: NodeJS.Platform): boolean {
  const lower = platform === "win32" ? name.toLowerCase() : name
  return platform === "win32"
    ? /^python(?:3(?:\.\d+)?)?\.exe$/.test(lower)
    : /^python(?:3(?:\.\d+)?)?$/.test(lower)
}

function parsePythonInfo(
  stdout: string,
): { executable: string; version: string; isVenv: boolean; isConda: boolean } | null {
  const line = stdout.trim().split(/\r?\n/).at(-1) ?? ""
  if (!line.startsWith("{")) return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!value || typeof value !== "object") return null
  const info = value as Record<string, unknown>
  if (
    typeof info.executable !== "string" ||
    typeof info.version !== "string" ||
    !/^\d+\.\d+$/.test(info.version) ||
    typeof info.isVenv !== "boolean" ||
    typeof info.isConda !== "boolean"
  ) {
    return null
  }
  return {
    executable: info.executable,
    version: info.version,
    isVenv: info.isVenv,
    isConda: info.isConda,
  }
}

function isExpectedUnavailableDirectory(cause: unknown): boolean {
  if (!(cause instanceof Error) || !("code" in cause)) return false
  const code = (cause as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM"
}
