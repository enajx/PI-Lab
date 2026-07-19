import { describe, expect, test } from "vitest"
import {
  discoverGlobalPythonEnvironments,
  globalPythonEnvironmentRoots,
  type PythonEnvironmentDiscoveryFileSystem,
  type PythonGlobalEnvironmentRoot,
} from "./globalEnvironments"

function rootPaths(
  roots: readonly PythonGlobalEnvironmentRoot[],
  manager: PythonGlobalEnvironmentRoot["manager"],
): string[] {
  return roots.filter((root) => root.manager === manager).map((root) => root.path)
}

describe("globalPythonEnvironmentRoots", () => {
  test("maps Linux manager defaults and idiomatic overrides without recursive search", () => {
    const roots = globalPythonEnvironmentRoots({
      platform: "linux",
      homeDir: "/home/ada",
      env: {
        PYENV_ROOT: "/opt/pyenv",
        CONDA_ENVS_PATH: "/data/conda-a:/data/conda-b",
        POETRY_CACHE_DIR: "/cache/poetry",
        POETRY_VIRTUALENVS_PATH: "/cache/poetry/virtualenvs",
        UV_PYTHON_INSTALL_DIR: "/data/uv-python",
        UV_TOOL_DIR: "/data/uv-tools",
        WORKON_HOME: "/data/workon",
        XDG_DATA_HOME: "/data/xdg",
      },
    })

    expect(rootPaths(roots, "pyenv")).toContain("/opt/pyenv/versions")
    expect(rootPaths(roots, "conda")).toEqual(
      expect.arrayContaining(["/data/conda-a", "/data/conda-b", "/home/ada/.conda/envs"]),
    )
    const poetryRoots = rootPaths(roots, "poetry")
    expect(poetryRoots[0]).toBe("/cache/poetry/virtualenvs")
    expect(poetryRoots.filter((path) => path === "/cache/poetry/virtualenvs")).toHaveLength(1)
    expect(rootPaths(roots, "uv")).toEqual(
      expect.arrayContaining(["/data/uv-python", "/data/uv-tools"]),
    )
    expect(rootPaths(roots, "virtualenvwrapper")).toContain("/data/workon")
    expect(roots.every((root) => root.depth === "direct" || root.depth === "children")).toBe(true)
  })

  test("uses macOS cache conventions and Windows path semantics", () => {
    const macRoots = globalPythonEnvironmentRoots({
      platform: "darwin",
      homeDir: "/Users/ada",
      env: {},
    })
    expect(rootPaths(macRoots, "poetry")).toContain(
      "/Users/ada/Library/Caches/pypoetry/virtualenvs",
    )

    const windowsRoots = globalPythonEnvironmentRoots({
      platform: "win32",
      homeDir: String.raw`C:\Users\Ada`,
      env: {
        LOCALAPPDATA: String.raw`C:\Users\Ada\AppData\Local`,
        APPDATA: String.raw`C:\Users\Ada\AppData\Roaming`,
        CONDA_ENVS_PATH: String.raw`D:\Conda Envs;E:\Shared\envs`,
      },
    })
    expect(rootPaths(windowsRoots, "pyenv")).toContain(
      String.raw`C:\Users\Ada\.pyenv\pyenv-win\versions`,
    )
    expect(rootPaths(windowsRoots, "conda")).toEqual(
      expect.arrayContaining([String.raw`D:\Conda Envs`, String.raw`E:\Shared\envs`]),
    )
    expect(rootPaths(windowsRoots, "poetry")).toContain(
      String.raw`C:\Users\Ada\AppData\Local\pypoetry\Cache\virtualenvs`,
    )
    expect(rootPaths(windowsRoots, "uv")).toContain(
      String.raw`C:\Users\Ada\AppData\Roaming\uv\data\python`,
    )
    expect(rootPaths(windowsRoots, "uv")).toContain(
      String.raw`C:\Users\Ada\AppData\Roaming\uv\data\tools`,
    )
    expect(rootPaths(windowsRoots, "virtualenvwrapper")).toContain(String.raw`C:\Users\Ada\Envs`)
  })

  test("returns no relative override roots and deduplicates repeated locations", () => {
    const roots = globalPythonEnvironmentRoots({
      platform: "linux",
      homeDir: "/home/ada",
      env: {
        PYENV_ROOT: "relative-pyenv",
        CONDA_ENVS_PATH: "/home/ada/.conda/envs:/home/ada/.conda/envs:relative",
        POETRY_VIRTUALENVS_PATH: "relative-poetry",
      },
    })

    expect(roots.some((root) => root.path.includes("relative"))).toBe(false)
    const condaRoots = rootPaths(roots, "conda")
    expect(new Set(condaRoots).size).toBe(condaRoots.length)
  })
})

describe("discoverGlobalPythonEnvironments", () => {
  test("enumerates only immediate environment children and direct manager bases", async () => {
    const reads: string[] = []
    const fileSystem: PythonEnvironmentDiscoveryFileSystem = {
      readDirectory: async (path) => {
        reads.push(path)
        if (path === "/managers/pyenv/versions") {
          return [
            { name: "3.13.2", isDirectory: true, isSymbolicLink: false },
            { name: "research", isDirectory: false, isSymbolicLink: true },
            { name: "README", isDirectory: false, isSymbolicLink: false },
          ]
        }
        throw fileSystemError("ENOENT")
      },
      isDirectory: async (path) => path === "/home/ada/miniforge3",
    }

    const candidates = await discoverGlobalPythonEnvironments({
      platform: "linux",
      homeDir: "/home/ada",
      env: { PYENV_ROOT: "/managers/pyenv" },
      fileSystem,
    })

    expect(candidates).toEqual(
      expect.arrayContaining([
        { manager: "pyenv", path: "/managers/pyenv/versions/3.13.2", environmentName: "3.13.2" },
        {
          manager: "pyenv",
          path: "/managers/pyenv/versions/research",
          environmentName: "research",
        },
        { manager: "conda", path: "/home/ada/miniforge3", environmentName: "miniforge3" },
      ]),
    )
    expect(reads).not.toContain("/managers/pyenv/versions/3.13.2")
  })

  test("skips absent and inaccessible roots but surfaces unexpected filesystem failures", async () => {
    const unavailableFileSystem: PythonEnvironmentDiscoveryFileSystem = {
      readDirectory: async () => {
        throw fileSystemError("EACCES")
      },
      isDirectory: async () => {
        throw fileSystemError("ENOENT")
      },
    }
    await expect(
      discoverGlobalPythonEnvironments({
        platform: "darwin",
        homeDir: "/Users/ada",
        env: {},
        fileSystem: unavailableFileSystem,
      }),
    ).resolves.toEqual([])

    const systemicFailure: PythonEnvironmentDiscoveryFileSystem = {
      readDirectory: async () => {
        throw fileSystemError("EIO")
      },
      isDirectory: async () => false,
    }
    await expect(
      discoverGlobalPythonEnvironments({
        platform: "linux",
        homeDir: "/home/ada",
        env: {},
        fileSystem: systemicFailure,
      }),
    ).rejects.toMatchObject({ code: "EIO" })
  })
})

function fileSystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}
