import { describe, expect, test } from "vitest"
import type { PythonProbe } from "./runtime"
import {
  discoverStandalonePythonInterpreters,
  type PythonStandaloneDiscoveryFileSystem,
  standalonePythonSearchDirectories,
} from "./standaloneInterpreters"

function fileSystem(
  directories: Readonly<Record<string, string[]>>,
  targets: Readonly<Record<string, string>>,
): PythonStandaloneDiscoveryFileSystem {
  return {
    readDirectory: async (path) => {
      const entries = directories[path]
      if (!entries) throw Object.assign(new Error(path), { code: "ENOENT" })
      return entries.map((name) => ({
        name,
        isFile: true,
        isDirectory: true,
        isSymbolicLink: false,
      }))
    },
    realPath: async (path) => targets[path] ?? path,
  }
}

function probeFor(
  interpreters: Readonly<
    Record<string, { executable: string; version: string; venv?: boolean; conda?: boolean }>
  >,
): PythonProbe {
  return async ({ command }) => {
    const python = interpreters[command]
    return python
      ? {
          stdout: JSON.stringify({
            executable: python.executable,
            version: python.version,
            isVenv: python.venv ?? false,
            isConda: python.conda ?? false,
          }),
          stderr: "",
          code: 0,
          notFound: false,
          timedOut: false,
        }
      : { stdout: "", stderr: "", code: 1, notFound: false, timedOut: false }
  }
}

describe("standalone Python discovery", () => {
  test("includes terminal PATH and conventional macOS installations while excluding virtual environments", async () => {
    const reads: string[] = []
    const fs = fileSystem(
      {
        "/terminal/bin": ["python", "python3", "python3.15", "python3-config", "python3.13m"],
        "/opt/homebrew/bin": [],
        "/usr/local/bin": [],
        "/opt/homebrew/opt": ["python@3.13", "python@3.15", "other"],
        "/opt/homebrew/opt/python@3.13/bin": ["python3.13"],
        "/opt/homebrew/opt/python@3.15/bin": ["python3.15"],
        "/usr/local/opt": [],
        "/Library/Frameworks/Python.framework/Versions": ["3.12", "Current", "README"],
        "/Library/Frameworks/Python.framework/Versions/3.12/bin": ["python3.12"],
      },
      {
        "/terminal/bin/python": "/actual/python315",
        "/terminal/bin/python3": "/actual/python315",
        "/terminal/bin/python3.15": "/actual/python315",
        "/opt/homebrew/opt/python@3.15/bin/python3.15": "/actual/python315",
      },
    )
    const wrappedFs: PythonStandaloneDiscoveryFileSystem = {
      readDirectory: async (path) => {
        reads.push(path)
        return fs.readDirectory(path)
      },
      realPath: fs.realPath,
    }
    const choices = await discoverStandalonePythonInterpreters({
      platform: "darwin",
      terminalPath: "/terminal/bin",
      cwd: "/work",
      fileSystem: wrappedFs,
      probe: probeFor({
        "/terminal/bin/python": { executable: "/terminal/bin/python", version: "3.15" },
        "/terminal/bin/python3": { executable: "/terminal/bin/python3", version: "3.15" },
        "/terminal/bin/python3.15": { executable: "/terminal/bin/python3.15", version: "3.15" },
        "/opt/homebrew/opt/python@3.13/bin/python3.13": {
          executable: "/opt/homebrew/opt/python@3.13/bin/python3.13",
          version: "3.13",
        },
        "/opt/homebrew/opt/python@3.15/bin/python3.15": {
          executable: "/opt/homebrew/opt/python@3.15/bin/python3.15",
          version: "3.15",
        },
        "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12": {
          executable: "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12",
          version: "3.12",
        },
      }),
    })

    expect(choices).toEqual([
      { path: "/actual/python315", displayName: "Python 3.15", version: "3.15" },
      {
        path: "/opt/homebrew/opt/python@3.13/bin/python3.13",
        displayName: "Python 3.13",
        version: "3.13",
      },
      {
        path: "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12",
        displayName: "Python 3.12",
        version: "3.12",
      },
    ])
    expect(reads).not.toContain("/opt/homebrew/opt/other")
    expect(reads).not.toContain("/Library/Frameworks/Python.framework/Versions/Current")
  })

  test("does not offer Python executables that belong to virtual or Conda environments", async () => {
    const choices = await discoverStandalonePythonInterpreters({
      platform: "linux",
      terminalPath: "/work/.venv/bin:/home/ada/miniconda3/envs/research/bin:/usr/bin",
      cwd: "/work",
      fileSystem: fileSystem(
        {
          "/work/.venv/bin": ["python"],
          "/home/ada/miniconda3/envs/research/bin": ["python"],
          "/usr/bin": ["python3.13"],
        },
        {},
      ),
      probe: probeFor({
        "/work/.venv/bin/python": {
          executable: "/work/.venv/bin/python",
          version: "3.13",
          venv: true,
        },
        "/usr/bin/python3.13": { executable: "/usr/bin/python3.13", version: "3.13" },
        "/home/ada/miniconda3/envs/research/bin/python": {
          executable: "/home/ada/miniconda3/envs/research/bin/python",
          version: "3.12",
          conda: true,
        },
      }),
    })
    expect(choices).toEqual([
      { path: "/usr/bin/python3.13", displayName: "Python 3.13", version: "3.13" },
    ])
  })

  test("uses only PATH on Linux and Windows and ignores relative PATH entries", () => {
    expect(
      standalonePythonSearchDirectories("linux", "/usr/bin:relative:/opt/bin:/usr/bin"),
    ).toEqual(["/usr/bin", "/opt/bin"])
    expect(
      standalonePythonSearchDirectories("win32", String.raw`C:\Python315;relative;C:\Windows`),
    ).toEqual([String.raw`C:\Python315`, String.raw`C:\Windows`])
  })
})
