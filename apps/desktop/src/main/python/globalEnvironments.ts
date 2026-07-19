import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"

export type PythonEnvironmentManager = "pyenv" | "conda" | "poetry" | "uv" | "virtualenvwrapper"

export interface PythonGlobalEnvironmentRoot {
  manager: PythonEnvironmentManager
  path: string
  /**
   * `children` enumerates only the root's immediate entries. `direct` treats
   * the root itself as an environment, for manager base installations.
   */
  depth: "children" | "direct"
}

export interface PythonGlobalEnvironmentCandidate {
  manager: PythonEnvironmentManager
  path: string
  environmentName: string
}

export interface PythonGlobalEnvironmentLocationOptions {
  platform: NodeJS.Platform
  homeDir: string
  env: Readonly<Record<string, string | undefined>>
  fileSystem?: PythonEnvironmentDiscoveryFileSystem
}

export type PythonEnvironmentDiscoverer = () => Promise<PythonGlobalEnvironmentCandidate[]>

export const livePythonEnvironmentDiscoverer: PythonEnvironmentDiscoverer = () =>
  discoverGlobalPythonEnvironments({
    platform: process.platform,
    homeDir: homedir(),
    env: process.env,
  })

export interface PythonEnvironmentDiscoveryDirectoryEntry {
  name: string
  isDirectory: boolean
  isSymbolicLink: boolean
}

export interface PythonEnvironmentDiscoveryFileSystem {
  readDirectory: (path: string) => Promise<PythonEnvironmentDiscoveryDirectoryEntry[]>
  isDirectory: (path: string) => Promise<boolean>
}

/**
 * Return conventional manager-owned environment roots without touching disk.
 * Platform path helpers are selected explicitly so Windows discovery is also
 * deterministic when exercised from a macOS or Linux test host.
 */
export function globalPythonEnvironmentRoots(
  options: PythonGlobalEnvironmentLocationOptions,
): PythonGlobalEnvironmentRoot[] {
  const paths = options.platform === "win32" ? win32 : posix
  const roots: PythonGlobalEnvironmentRoot[] = []
  const seen = new Set<string>()
  const add = (
    manager: PythonEnvironmentManager,
    path: string | undefined,
    depth: PythonGlobalEnvironmentRoot["depth"],
  ): void => {
    if (!path || !paths.isAbsolute(path)) return
    const normalized = paths.normalize(path)
    const key = `${manager}\0${depth}\0${normalized}`
    if (seen.has(key)) return
    seen.add(key)
    roots.push({ manager, path: normalized, depth })
  }
  const addChildren = (manager: PythonEnvironmentManager, path: string | undefined): void =>
    add(manager, path, "children")
  const addDirect = (manager: PythonEnvironmentManager, path: string | undefined): void =>
    add(manager, path, "direct")
  const under = (base: string | undefined, ...parts: string[]): string | undefined =>
    base ? paths.join(base, ...parts) : undefined

  addChildren("pyenv", under(options.env.PYENV_ROOT, "versions"))
  if (options.platform === "win32") {
    addChildren("pyenv", under(options.homeDir, ".pyenv", "pyenv-win", "versions"))
  }
  addChildren("pyenv", under(options.homeDir, ".pyenv", "versions"))

  for (const path of splitPathList(options.env.CONDA_ENVS_PATH, options.platform)) {
    addChildren("conda", path)
  }
  addChildren("conda", under(options.homeDir, ".conda", "envs"))
  addDirect("conda", options.env.CONDA_PREFIX)
  for (const distribution of ["miniconda3", "anaconda3", "miniforge3", "mambaforge"]) {
    const base = under(options.homeDir, distribution)
    addDirect("conda", base)
    addChildren("conda", under(base, "envs"))
  }

  addChildren("poetry", options.env.POETRY_VIRTUALENVS_PATH)
  addChildren("poetry", under(options.env.POETRY_CACHE_DIR, "virtualenvs"))
  addChildren("poetry", under(options.env.XDG_CACHE_HOME, "pypoetry", "virtualenvs"))
  if (options.platform === "darwin") {
    addChildren("poetry", under(options.homeDir, "Library", "Caches", "pypoetry", "virtualenvs"))
  } else if (options.platform === "win32") {
    addChildren("poetry", under(options.env.LOCALAPPDATA, "pypoetry", "Cache", "virtualenvs"))
  } else {
    addChildren("poetry", under(options.homeDir, ".cache", "pypoetry", "virtualenvs"))
  }

  addChildren("uv", options.env.UV_PYTHON_INSTALL_DIR)
  addChildren("uv", options.env.UV_TOOL_DIR)
  if (options.platform === "win32") {
    addChildren("uv", under(options.env.APPDATA, "uv", "data", "python"))
    addChildren("uv", under(options.env.APPDATA, "uv", "data", "tools"))
  } else {
    const dataHome = options.env.XDG_DATA_HOME ?? under(options.homeDir, ".local", "share")
    addChildren("uv", under(dataHome, "uv", "python"))
    addChildren("uv", under(dataHome, "uv", "tools"))
  }

  addChildren("virtualenvwrapper", options.env.WORKON_HOME)
  addChildren("virtualenvwrapper", under(options.homeDir, ".virtualenvs"))
  if (options.platform === "win32") {
    addChildren("virtualenvwrapper", under(options.homeDir, "Envs"))
  }

  return roots
}

/**
 * Shallowly enumerate the conventional roots. Missing and user-inaccessible
 * roots are normal on machines that do not use a given manager; unexpected I/O
 * failures remain visible to the caller.
 */
export async function discoverGlobalPythonEnvironments(
  options: PythonGlobalEnvironmentLocationOptions,
): Promise<PythonGlobalEnvironmentCandidate[]> {
  const paths = options.platform === "win32" ? win32 : posix
  const fileSystem = options.fileSystem ?? liveDiscoveryFileSystem
  const candidates: PythonGlobalEnvironmentCandidate[] = []
  for (const root of globalPythonEnvironmentRoots(options)) {
    if (root.depth === "direct") {
      let directory: boolean
      try {
        directory = await fileSystem.isDirectory(root.path)
      } catch (cause) {
        if (isExpectedUnavailableRoot(cause)) continue
        throw cause
      }
      if (!directory) continue
      candidates.push({
        manager: root.manager,
        path: root.path,
        environmentName: paths.basename(root.path) || root.path,
      })
      continue
    }

    let entries: PythonEnvironmentDiscoveryDirectoryEntry[]
    try {
      entries = await fileSystem.readDirectory(root.path)
    } catch (cause) {
      if (isExpectedUnavailableRoot(cause)) continue
      throw cause
    }
    for (const entry of entries) {
      if (!entry.isDirectory && !entry.isSymbolicLink) continue
      candidates.push({
        manager: root.manager,
        path: paths.join(root.path, entry.name),
        environmentName: entry.name,
      })
    }
  }
  return candidates
}

const liveDiscoveryFileSystem: PythonEnvironmentDiscoveryFileSystem = {
  readDirectory: async (path) =>
    (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    })),
  isDirectory: async (path) => (await stat(path)).isDirectory(),
}

function splitPathList(value: string | undefined, platform: NodeJS.Platform): string[] {
  if (!value) return []
  const delimiter = platform === "win32" ? ";" : ":"
  return value.split(delimiter).filter(Boolean)
}

function isExpectedUnavailableRoot(cause: unknown): boolean {
  if (!(cause instanceof Error) || !("code" in cause)) return false
  const code = (cause as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM"
}
