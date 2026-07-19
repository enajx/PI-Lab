import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  environmentDirForInterpreter,
  type PythonProbe,
  type PythonProbeResult,
  resolvePythonRuntime,
} from "./runtime"

type ProbeCall = Parameters<PythonProbe>[0]

const MISSING: PythonProbeResult = {
  stdout: "",
  stderr: "",
  code: null,
  notFound: true,
  timedOut: false,
}

let workspaceDir: string

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "pi-lab-python-runtime-"))
})

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true })
})

async function addInterpreter(envDir: string, relPath: string): Promise<string> {
  const interpreter = join(envDir, relPath)
  await mkdir(join(interpreter, ".."), { recursive: true })
  await writeFile(interpreter, "")
  return interpreter
}

function recordingProbe(
  response: (call: ProbeCall) => PythonProbeResult = (call) => ({
    stdout: `${call.command}\n`,
    stderr: "",
    code: 0,
    notFound: false,
    timedOut: false,
  }),
): { probe: PythonProbe; calls: ProbeCall[] } {
  const calls: ProbeCall[] = []
  const probe: PythonProbe = async (call) => {
    calls.push(call)
    return response(call)
  }
  return { probe, calls }
}

function options(
  probe: PythonProbe,
  env: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = "linux",
) {
  return { env, platform, probe }
}

describe("resolvePythonRuntime environment precedence", () => {
  test("prefers .venv before venv, configured uv, Poetry, and inherited environments", async () => {
    const dotVenvPython = await addInterpreter(join(workspaceDir, ".venv"), "bin/python3")
    await addInterpreter(join(workspaceDir, "venv"), "bin/python3")
    await addInterpreter(join(workspaceDir, ".uv-env"), "bin/python3")
    await addInterpreter(join(workspaceDir, ".inherited"), "bin/python3")
    await addInterpreter(join(workspaceDir, ".conda"), "bin/python3")
    await writeFile(join(workspaceDir, "pyproject.toml"), "[tool.poetry]\nname = 'fixture'\n")
    const { probe, calls } = recordingProbe()

    const runtime = await resolvePythonRuntime(
      workspaceDir,
      options(probe, {
        UV_PROJECT_ENVIRONMENT: ".uv-env",
        VIRTUAL_ENV: join(workspaceDir, ".inherited"),
        CONDA_PREFIX: join(workspaceDir, ".conda"),
      }),
      null,
    )

    expect(runtime).toEqual({
      source: "dot-venv",
      displayName: `${basename(workspaceDir)}/.venv`,
      interpreterPath: dotVenvPython,
      runStrategy: { kind: "environment", command: dotVenvPython, argsPrefix: [] },
    })
    expect(calls.map((call) => call.command)).toEqual([dotVenvPython])
  })

  test("skips a broken .venv and selects venv", async () => {
    const brokenPython = await addInterpreter(join(workspaceDir, ".venv"), "bin/python3")
    const venvPython = await addInterpreter(join(workspaceDir, "venv"), "bin/python3")
    const { probe, calls } = recordingProbe((call) =>
      call.command === brokenPython
        ? { ...MISSING, notFound: false, code: 1, stderr: "broken interpreter" }
        : {
            stdout: `${call.command}\n`,
            stderr: "",
            code: 0,
            notFound: false,
            timedOut: false,
          },
    )

    const runtime = await resolvePythonRuntime(workspaceDir, options(probe), null)

    expect(runtime.source).toBe("venv")
    expect(runtime.interpreterPath).toBe(venvPython)
    expect(calls.map((call) => call.command)).toEqual([brokenPython, venvPython])
  })

  test("uses a workspace-relative configured uv environment after local environments", async () => {
    const uvPython = await addInterpreter(join(workspaceDir, "runtime", "uv"), "bin/python3")
    const { probe } = recordingProbe()

    const runtime = await resolvePythonRuntime(
      workspaceDir,
      options(probe, { UV_PROJECT_ENVIRONMENT: "runtime/uv" }),
      null,
    )

    expect(runtime).toMatchObject({
      source: "uv-project",
      displayName: `${basename(workspaceDir)}/uv`,
      interpreterPath: uvPython,
      runStrategy: { kind: "environment", command: uvPython, argsPrefix: [] },
    })
  })

  test("resolves a .venv from a nested worktree root rather than its parent repository", async () => {
    const worktree = join(workspaceDir, "managed", "worktree")
    await mkdir(worktree, { recursive: true })
    await addInterpreter(join(workspaceDir, ".venv"), "bin/python3")
    const worktreePython = await addInterpreter(join(worktree, ".venv"), "bin/python3")
    const { probe } = recordingProbe()

    const runtime = await resolvePythonRuntime(worktree, options(probe), null)

    expect(runtime.source).toBe("dot-venv")
    expect(runtime.interpreterPath).toBe(worktreePython)
  })
})

describe("environmentDirForInterpreter", () => {
  test("infers POSIX, Windows Scripts, and Windows manager-root layouts", () => {
    expect(environmentDirForInterpreter("/env/research/bin/python")).toBe("/env/research")
    expect(environmentDirForInterpreter(String.raw`C:\envs\research\Scripts\python.exe`)).toBe(
      String.raw`C:\envs\research`,
    )
    expect(environmentDirForInterpreter(String.raw`C:\envs\research\python.exe`)).toBe(
      String.raw`C:\envs\research`,
    )
  })
})

describe("resolvePythonRuntime layouts and managers", () => {
  test("labels a project environment with project, environment, and Python version", async () => {
    const interpreter = await addInterpreter(join(workspaceDir, ".venv"), "bin/python3")
    const { probe } = recordingProbe((call) => ({
      stdout: `${JSON.stringify({ executable: call.command, version: "3.13" })}\n`,
      stderr: "",
      code: 0,
      notFound: false,
      timedOut: false,
    }))

    const runtime = await resolvePythonRuntime(workspaceDir, options(probe), null)

    expect(runtime).toMatchObject({
      source: "dot-venv",
      displayName: `${basename(workspaceDir)}/.venv (3.13)`,
      interpreterPath: interpreter,
    })
  })

  test("keeps an inherited environment label to its environment name", async () => {
    const envDir = join(workspaceDir, "shared-conda")
    await addInterpreter(envDir, "bin/python3")
    const { probe } = recordingProbe((call) => ({
      stdout: `${JSON.stringify({ executable: call.command, version: "3.12" })}\n`,
      stderr: "",
      code: 0,
      notFound: false,
      timedOut: false,
    }))

    const runtime = await resolvePythonRuntime(
      workspaceDir,
      options(probe, { CONDA_PREFIX: envDir }),
      null,
    )

    expect(runtime.displayName).toBe("shared-conda")
  })

  test("validates a manually selected environment without probing fallback runtimes", async () => {
    const envDir = join(workspaceDir, "custom-env")
    const interpreter = await addInterpreter(envDir, "bin/python3")
    const { probe, calls } = recordingProbe((call) => ({
      stdout: `${JSON.stringify({ executable: call.command, version: "3.11" })}\n`,
      stderr: "",
      code: 0,
      notFound: false,
      timedOut: false,
    }))

    const runtime = await resolvePythonRuntime(workspaceDir, options(probe), envDir)

    expect(runtime).toMatchObject({
      source: "selected",
      displayName: `${basename(workspaceDir)}/custom-env (3.11)`,
      interpreterPath: interpreter,
      environmentPath: envDir,
    })
    expect(calls.map(({ command }) => command)).toEqual([interpreter])

    const selectedInterpreter = await resolvePythonRuntime(
      workspaceDir,
      options(probe),
      interpreter,
    )
    expect(selectedInterpreter.source).toBe("selected")
    expect(selectedInterpreter.environmentPath).toBeUndefined()

    await writeFile(join(envDir, "pyvenv.cfg"), "home = /usr/bin\n")
    const selectedVenvInterpreter = await resolvePythonRuntime(
      workspaceDir,
      options(probe),
      interpreter,
    )
    expect(selectedVenvInterpreter.environmentPath).toBe(envDir)

    const missing = await resolvePythonRuntime(
      workspaceDir,
      options(probe),
      join(workspaceDir, "missing-env"),
    )
    expect(missing.runStrategy.kind).toBe("unavailable")
    expect(calls.map(({ command }) => command)).toEqual([interpreter, interpreter, interpreter])
  })

  test("accepts the POSIX bin/python3 layout", async () => {
    const interpreter = await addInterpreter(join(workspaceDir, ".venv"), "bin/python3")
    const { probe } = recordingProbe()

    const runtime = await resolvePythonRuntime(workspaceDir, options(probe, {}, "linux"), null)

    expect(runtime.interpreterPath).toBe(interpreter)
  })

  test("accepts the Windows Scripts/python.exe layout", async () => {
    const interpreter = await addInterpreter(join(workspaceDir, ".venv"), "Scripts/python.exe")
    const { probe, calls } = recordingProbe()

    const runtime = await resolvePythonRuntime(workspaceDir, options(probe, {}, "win32"), null)

    expect(runtime.interpreterPath).toBe(interpreter)
    expect(calls[0]?.command).toBe(interpreter)
  })

  test("accepts the Windows manager-root python.exe layout for a selected environment", async () => {
    const environmentPath = join(workspaceDir, "conda", "research")
    const interpreter = await addInterpreter(environmentPath, "python.exe")
    const { probe, calls } = recordingProbe()

    const runtime = await resolvePythonRuntime(
      workspaceDir,
      options(probe, {}, "win32"),
      environmentPath,
    )

    expect(runtime).toMatchObject({
      source: "selected",
      environmentPath,
      interpreterPath: interpreter,
    })
    expect(calls[0]?.command).toBe(interpreter)
  })

  test("uses Poetry's interpreter for a Poetry project", async () => {
    await writeFile(join(workspaceDir, "pyproject.toml"), "[tool.poetry]\nname = 'fixture'\n")
    const poetryPython = join(workspaceDir, ".cache", "poetry", "bin", "python")
    const { probe, calls } = recordingProbe((call) => ({
      stdout: `${call.command === "poetry" ? poetryPython : call.command}\n`,
      stderr: "",
      code: 0,
      notFound: false,
      timedOut: false,
    }))

    const runtime = await resolvePythonRuntime(workspaceDir, options(probe), null)

    expect(runtime).toMatchObject({
      source: "poetry",
      displayName: "poetry",
      interpreterPath: poetryPython,
    })
    expect(calls).toEqual([
      {
        command: "poetry",
        args: ["env", "info", "--executable"],
        cwd: workspaceDir,
        timeoutMs: 3_000,
      },
      {
        command: poetryPython,
        args: ["-c", expect.any(String)],
        cwd: workspaceDir,
        timeoutMs: 3_000,
      },
    ])
  })

  test.each([
    ["is absent", { ...MISSING }],
    ["times out", { ...MISSING, notFound: false, timedOut: true }],
  ])("falls through to inherited VIRTUAL_ENV when Poetry %s", async (_label, poetryResult) => {
    await writeFile(join(workspaceDir, "pyproject.toml"), "[tool.poetry]\nname = 'fixture'\n")
    const inheritedPython = await addInterpreter(join(workspaceDir, "inherited"), "bin/python3")
    const { probe } = recordingProbe((call) =>
      call.command === "poetry"
        ? poetryResult
        : {
            stdout: `${call.command}\n`,
            stderr: "",
            code: 0,
            notFound: false,
            timedOut: false,
          },
    )

    const runtime = await resolvePythonRuntime(
      workspaceDir,
      options(probe, { VIRTUAL_ENV: join(workspaceDir, "inherited") }),
      null,
    )

    expect(runtime.source).toBe("virtual-env")
    expect(runtime.interpreterPath).toBe(inheritedPython)
  })

  test("prefers inherited VIRTUAL_ENV over inherited conda", async () => {
    const virtualPython = await addInterpreter(join(workspaceDir, "virtual"), "bin/python3")
    await addInterpreter(join(workspaceDir, "conda"), "bin/python3")
    const { probe } = recordingProbe()

    const runtime = await resolvePythonRuntime(
      workspaceDir,
      options(probe, {
        VIRTUAL_ENV: join(workspaceDir, "virtual"),
        CONDA_PREFIX: join(workspaceDir, "conda"),
      }),
      null,
    )

    expect(runtime.source).toBe("virtual-env")
    expect(runtime.interpreterPath).toBe(virtualPython)
  })
})

describe("resolvePythonRuntime no-environment strategies", () => {
  test("prefers uv run python for a recognized uv project", async () => {
    await writeFile(join(workspaceDir, "uv.lock"), "")
    const { probe, calls } = recordingProbe((call) =>
      call.command === "uv"
        ? {
            stdout: "uv 0.8.0\n",
            stderr: "",
            code: 0,
            notFound: false,
            timedOut: false,
          }
        : MISSING,
    )

    const runtime = await resolvePythonRuntime(workspaceDir, options(probe), null)

    expect(runtime).toEqual({
      source: null,
      displayName: "No virtual env",
      interpreterPath: null,
      runStrategy: { kind: "uv-project", command: "uv", argsPrefix: ["run", "python"] },
    })
    expect(calls.map((call) => call.command)).toEqual(["uv"])
  })

  test("falls back from a timed-out uv manager to python3", async () => {
    await writeFile(join(workspaceDir, "pyproject.toml"), "[tool.uv]\ndev-dependencies = []\n")
    const python3 = "/usr/local/bin/python3"
    const { probe, calls } = recordingProbe((call) => {
      if (call.command === "uv") {
        return { ...MISSING, notFound: false, timedOut: true }
      }
      if (call.command === "python3") {
        return {
          stdout: `${python3}\n`,
          stderr: "",
          code: 0,
          notFound: false,
          timedOut: false,
        }
      }
      return MISSING
    })

    const runtime = await resolvePythonRuntime(workspaceDir, options(probe), null)

    expect(runtime).toMatchObject({
      source: null,
      displayName: "No virtual env",
      interpreterPath: python3,
      runStrategy: { kind: "python3", command: python3, argsPrefix: [] },
    })
    expect(calls.map((call) => call.command)).toEqual(["uv", "python3"])
  })

  test("falls back from a missing python3 to python", async () => {
    const python = "/usr/bin/python"
    const { probe, calls } = recordingProbe((call) =>
      call.command === "python"
        ? {
            stdout: `${python}\n`,
            stderr: "",
            code: 0,
            notFound: false,
            timedOut: false,
          }
        : MISSING,
    )

    const runtime = await resolvePythonRuntime(workspaceDir, options(probe), null)

    expect(runtime.runStrategy).toEqual({ kind: "python", command: python, argsPrefix: [] })
    expect(calls.map((call) => call.command)).toEqual(["python3", "python"])
  })

  test("returns the explicit unavailable outcome when no manager or interpreter works", async () => {
    const { probe } = recordingProbe(() => MISSING)

    const runtime = await resolvePythonRuntime(workspaceDir, options(probe), null)

    expect(runtime).toEqual({
      source: null,
      displayName: "No virtual env",
      interpreterPath: null,
      runStrategy: { kind: "unavailable", command: null, argsPrefix: [] },
    })
  })
})
