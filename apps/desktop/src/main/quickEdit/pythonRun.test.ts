import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type DaemonClient, DaemonError } from "@pi-lab/pty-daemon"
import { afterEach, describe, expect, test } from "vitest"
import type { PythonRuntime } from "../python"
import { QuickPythonRunner } from "./pythonRun"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const automatic: PythonRuntime = {
  source: "dot-venv",
  displayName: "Local Python",
  interpreterPath: "/python/default",
  runStrategy: { kind: "environment", command: "/python/default", argsPrefix: [] },
}
const selected: PythonRuntime = {
  source: "selected",
  displayName: "Chosen Python",
  interpreterPath: "/python/chosen",
  runStrategy: { kind: "environment", command: "/python/chosen", argsPrefix: [] },
}

async function fixture(): Promise<{
  file: string
  runner: QuickPythonRunner
  spawns: unknown[]
  probes: Array<string | null>
  kills: string[]
}> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-quick-python-"))
  dirs.push(dir)
  const file = join(dir, "hello.py")
  await writeFile(file, "print('hello')\n")
  const spawns: unknown[] = []
  const probes: Array<string | null> = []
  const kills: string[] = []
  const client = {
    spawn: async (request: unknown) => {
      spawns.push(request)
      return { id: "session-1" }
    },
    kill: async (sessionId: string) => {
      kills.push(sessionId)
    },
  }
  const runner = new QuickPythonRunner({
    resolveRuntime: async (_cwd, path) => {
      probes.push(path)
      return path ? selected : automatic
    },
    discoverStandalonePython: async () => [],
    probeRuntime: async () => ({
      stdout: "",
      stderr: "",
      code: null,
      notFound: true,
      timedOut: false,
    }),
    getDaemonClient: async () => client as unknown as DaemonClient,
  })
  return { file, runner, spawns, probes, kills }
}

describe("QuickPythonRunner", () => {
  test("uses a registered project root environment for a Python file in a subfolder", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-lab-quick-project-python-"))
    dirs.push(project)
    const folder = join(project, "src", "nested")
    await mkdir(folder, { recursive: true })
    const file = join(folder, "hello.py")
    await writeFile(file, "print('hello')\n")
    const projectPython = join(project, ".venv", "bin", "python3")
    await mkdir(dirname(projectPython), { recursive: true })
    await writeFile(projectPython, "")
    const resolveDirs: string[] = []
    const spawns: Array<{ command: string; cwd: string }> = []
    const runner = new QuickPythonRunner({
      resolveRuntime: async (cwd, selectedPath) => {
        resolveDirs.push(cwd)
        return {
          source: selectedPath ? "selected" : "dot-venv",
          displayName: "Project Python",
          interpreterPath: projectPython,
          runStrategy: { kind: "environment", command: projectPython, argsPrefix: [] },
        }
      },
      discoverStandalonePython: async () => [],
      projectRootForFile: async () => project,
      probeRuntime: async () => ({
        stdout: "",
        stderr: "",
        code: null,
        notFound: true,
        timedOut: false,
      }),
      getDaemonClient: async () =>
        ({
          spawn: async (request: { command: string; cwd: string }) => {
            spawns.push({ command: request.command, cwd: request.cwd })
            return { id: "project-session" }
          },
        }) as unknown as DaemonClient,
    })
    const result = await runner.options(file)
    expect(result.options.map((option) => option.path)).toContain(join(project, ".venv"))
    await runner.run(file, 80, 24)
    expect(resolveDirs).toContain(project)
    expect(spawns).toEqual([{ command: projectPython, cwd: dirname(await realpath(file)) }])
  })

  test("runs a saved Python file in its folder and keeps a manual choice for this session", async () => {
    const { file, runner, spawns, probes } = await fixture()
    const selectedRuntime = await runner.select(file, "/chosen/env")
    expect(selectedRuntime).toEqual(selected)
    const result = await runner.run(file, 80, 24)
    expect(result).toEqual({ sessionId: "session-1", runtime: selected })
    expect(spawns).toEqual([
      {
        command: "/python/chosen",
        args: ["hello.py"],
        cwd: dirname(await realpath(file)),
        cols: 80,
        rows: 24,
      },
    ])
    expect(probes).toContain("/chosen/env")
  })

  test("stops only a process started by this quick editor", async () => {
    const { file, runner, kills } = await fixture()
    const { sessionId } = await runner.run(file, 80, 24)
    await runner.kill(sessionId)
    expect(kills).toEqual([sessionId])
    await expect(runner.kill(sessionId)).rejects.toThrow("Unknown quick Python session")
  })

  test("closing a terminal succeeds after the daemon has reaped a finished process", async () => {
    const { file } = await fixture()
    const runner = new QuickPythonRunner({
      resolveRuntime: async () => automatic,
      discoverStandalonePython: async () => [],
      probeRuntime: async () => ({
        stdout: "",
        stderr: "",
        code: null,
        notFound: true,
        timedOut: false,
      }),
      getDaemonClient: async () =>
        ({
          spawn: async () => ({ id: "finished-session" }),
          kill: async () => {
            throw new DaemonError("unknown-session", "already reaped")
          },
        }) as unknown as DaemonClient,
    })
    const { sessionId } = await runner.run(file, 80, 24)
    await expect(runner.kill(sessionId)).resolves.toBeUndefined()
    await expect(runner.kill(sessionId)).rejects.toThrow("Unknown quick Python session")
  })

  test("shows the file's local environment and standalone Python", async () => {
    const { file } = await fixture()
    const folder = dirname(await realpath(file))
    const localInterpreter = join(folder, ".venv", "bin", "python")
    const standaloneInterpreter = join(folder, "installed", "python3.15")
    await mkdir(dirname(localInterpreter), { recursive: true })
    await mkdir(dirname(standaloneInterpreter), { recursive: true })
    await writeFile(localInterpreter, "")
    await writeFile(standaloneInterpreter, "")
    let discoveryCalls = 0
    const runner = new QuickPythonRunner({
      resolveRuntime: async (_cwd, path) => {
        if (!path) return automatic
        if (path === join(folder, ".venv")) {
          return { ...selected, displayName: "Local", interpreterPath: localInterpreter }
        }
        if (path === standaloneInterpreter) {
          return { ...selected, displayName: "Python 3.15", interpreterPath: standaloneInterpreter }
        }
        return { ...automatic, source: null, interpreterPath: null }
      },
      discoverStandalonePython: async () => {
        discoveryCalls += 1
        return [{ path: standaloneInterpreter, displayName: "Python 3.15", version: "3.15" }]
      },
      probeRuntime: async () => ({
        stdout: "",
        stderr: "",
        code: null,
        notFound: true,
        timedOut: false,
      }),
      getDaemonClient: async () =>
        ({ spawn: async () => ({ id: "standalone-session" }) }) as unknown as DaemonClient,
    })
    expect(discoveryCalls).toBe(0)
    const result = await runner.options(file)
    expect(result.options).toEqual([
      { path: join(folder, ".venv"), displayName: "Local", interpreterPath: localInterpreter },
      {
        path: standaloneInterpreter,
        displayName: "Python 3.15",
        interpreterPath: standaloneInterpreter,
      },
    ])
    expect(discoveryCalls).toBe(1)
    const chosen = await runner.select(file, standaloneInterpreter)
    expect(chosen).toMatchObject({ source: "selected" })
    expect(await runner.run(file, 80, 24)).toMatchObject({
      runtime: { source: "selected" },
    })
  })

  test("does not create a missing uv project environment when the picker opens", async () => {
    const { file } = await fixture()
    let probeCalls = 0
    const runner = new QuickPythonRunner({
      resolveRuntime: async () => ({
        source: null,
        displayName: "No virtual env",
        interpreterPath: null,
        runStrategy: { kind: "uv-project", command: "uv", argsPrefix: ["run", "python"] },
      }),
      discoverStandalonePython: async () => [],
      probeRuntime: async () => {
        probeCalls += 1
        throw new Error("Opening the picker must not run uv")
      },
      getDaemonClient: async () => {
        throw new Error("not needed")
      },
    })
    expect(probeCalls).toBe(0)
    const result = await runner.options(file)
    expect(result.runtime).toMatchObject({
      interpreterPath: null,
      runStrategy: { kind: "uv-project", command: "uv" },
    })
    expect(probeCalls).toBe(0)
  })

  test("rejects a non-Python file before starting a process", async () => {
    const { file, runner, spawns } = await fixture()
    await expect(runner.run(file.replace(/\.py$/, ".txt"), 80, 24)).rejects.toThrow("Python file")
    expect(spawns).toHaveLength(0)
  })
})
