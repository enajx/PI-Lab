import { access, mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Unsubscribable } from "@trpc/server/observable"
import { afterEach, describe, expect, test } from "vitest"
import type {
  PythonEnvironmentDiscoverer,
  PythonRuntime,
  PythonRuntimeResolver,
} from "../../python"
import type { TerminalEvent } from "../terminal/terminal"
import { createHarness, type Harness } from "../testHarness"

const NODE_RUNTIME: PythonRuntime = {
  source: null,
  displayName: "No virtual env",
  interpreterPath: process.execPath,
  runStrategy: { kind: "python", command: process.execPath, argsPrefix: [] },
}

let h: Harness | undefined
const subscriptions: Unsubscribable[] = []

afterEach(async () => {
  for (const subscription of subscriptions) subscription.unsubscribe()
  subscriptions.length = 0
  await h?.dispose()
  h = undefined
})

async function setup(
  resolvePythonRuntime: PythonRuntimeResolver,
  discoverPythonEnvironments?: PythonEnvironmentDiscoverer,
): Promise<{
  workspaceId: string
  workspaceDir: string
}> {
  h = await createHarness(undefined, { resolvePythonRuntime, discoverPythonEnvironments })
  const project = await h.caller.projects.open({ path: h.repoDir })
  const workspace = await h.caller.workspaces.ensureMain({ projectId: project.id })
  return { workspaceId: workspace.id, workspaceDir: h.repoDir }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("waitFor timed out")
}

async function collect(sessionId: string): Promise<{ chunks: string[]; exits: TerminalEvent[] }> {
  if (!h) throw new Error("Harness is not initialized")
  const chunks: string[] = []
  const exits: TerminalEvent[] = []
  const stream = await h.caller.terminal.onData({ sessionId })
  const subscription = stream.subscribe({
    next: (event: TerminalEvent) => {
      if (event.type === "data") chunks.push(event.chunk)
      else exits.push(event)
    },
  })
  subscriptions.push(subscription)
  return { chunks, exits }
}

describe("python.resolve", () => {
  test("resolves the selected workspace through the typed public router", async () => {
    const calls: string[] = []
    const expected: PythonRuntime = {
      source: "dot-venv",
      displayName: ".venv",
      interpreterPath: "/fixture/.venv/bin/python",
      runStrategy: {
        kind: "environment",
        command: "/fixture/.venv/bin/python",
        argsPrefix: [],
      },
    }
    const { workspaceId, workspaceDir } = await setup(async (cwd) => {
      calls.push(cwd)
      return expected
    })

    await expect(h?.caller.python.resolve({ workspaceId })).resolves.toEqual(expected)
    expect(calls).toEqual([workspaceDir])
  })

  test("rejects an unknown workspace", async () => {
    await setup(async () => NODE_RUNTIME)

    await expect(h?.caller.python.resolve({ workspaceId: "ghost" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  test("persists a validated manual selection and uses it on later resolves", async () => {
    const calls: Array<string | null> = []
    const selectedPath = "/shared/conda/research"
    const selectedRuntime: PythonRuntime = {
      source: "selected",
      displayName: "research",
      interpreterPath: "/shared/conda/research/bin/python",
      runStrategy: {
        kind: "environment",
        command: "/shared/conda/research/bin/python",
        argsPrefix: [],
      },
    }
    const { workspaceId } = await setup(async (_cwd, path) => {
      calls.push(path)
      return path === selectedPath ? selectedRuntime : NODE_RUNTIME
    })

    await expect(h?.caller.python.select({ workspaceId, path: selectedPath })).resolves.toEqual(
      selectedRuntime,
    )
    calls.length = 0
    await expect(h?.caller.python.resolve({ workspaceId })).resolves.toEqual(selectedRuntime)
    expect(calls).toEqual([selectedPath])
  })

  test("lists usual workspace environments and cheaply detects a newly created .venv", async () => {
    const calls: Array<string | null> = []
    const { workspaceId, workspaceDir: resolvedWorkspaceDir } = await setup(
      async (cwd, selectedPath) => {
        calls.push(selectedPath)
        const dotVenv = join(cwd, ".venv")
        if (selectedPath === dotVenv) {
          return {
            source: "selected",
            displayName: "repo/.venv (3.13)",
            interpreterPath: join(dotVenv, "bin/python"),
            runStrategy: {
              kind: "environment",
              command: join(dotVenv, "bin/python"),
              argsPrefix: [],
            },
          }
        }
        return NODE_RUNTIME
      },
    )
    await mkdir(join(resolvedWorkspaceDir, ".venv/bin"), { recursive: true })
    await writeFile(join(resolvedWorkspaceDir, ".venv/bin/python"), "fixture\n")

    const options = await h?.caller.python.options({ workspaceId })
    expect(options).toEqual([
      {
        path: join(resolvedWorkspaceDir, ".venv"),
        displayName: "repo/.venv (3.13)",
        interpreterPath: join(resolvedWorkspaceDir, ".venv/bin/python"),
      },
    ])

    calls.length = 0
    await expect(h?.caller.python.resolveLocal({ workspaceId })).resolves.toMatchObject({
      source: "dot-venv",
      interpreterPath: join(resolvedWorkspaceDir, ".venv/bin/python"),
    })
    expect(calls).toEqual([join(resolvedWorkspaceDir, ".venv")])
  })

  test("appends validated manager environments with clear labels and canonical deduplication", async () => {
    let condaPath = ""
    let poetryAlias = ""
    let brokenPath = ""
    const resolverCalls: Array<string | null> = []
    const { workspaceId, workspaceDir } = await setup(
      async (cwd, selectedPath) => {
        resolverCalls.push(selectedPath)
        if (selectedPath === join(cwd, ".venv")) {
          return {
            source: "selected",
            displayName: "repo/.venv (3.13)",
            interpreterPath: join(cwd, ".venv/bin/python"),
            runStrategy: {
              kind: "environment",
              command: join(cwd, ".venv/bin/python"),
              argsPrefix: [],
            },
          }
        }
        if (selectedPath === condaPath || selectedPath === poetryAlias) {
          const interpreterPath = join(selectedPath, "bin/python")
          return {
            source: "selected",
            displayName: "research (3.12)",
            interpreterPath,
            runStrategy: { kind: "environment", command: interpreterPath, argsPrefix: [] },
          }
        }
        return NODE_RUNTIME
      },
      async () => [
        { manager: "conda", path: condaPath, environmentName: "research" },
        { manager: "poetry", path: poetryAlias, environmentName: "research-alias" },
        { manager: "pyenv", path: brokenPath, environmentName: "broken" },
      ],
    )
    condaPath = join(workspaceDir, "global/conda/envs/research")
    poetryAlias = join(workspaceDir, "global/poetry/research-alias")
    brokenPath = join(workspaceDir, "global/pyenv/versions/broken")
    await Promise.all([
      mkdir(join(workspaceDir, ".venv/bin"), { recursive: true }),
      mkdir(join(condaPath, "bin"), { recursive: true }),
      mkdir(join(poetryAlias, "bin"), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(workspaceDir, ".venv/bin/python"), "local fixture\n"),
      writeFile(join(condaPath, "bin/python"), "global fixture\n"),
    ])
    await symlink(join(condaPath, "bin/python"), join(poetryAlias, "bin/python"))
    const interpreterPath = join(condaPath, "bin/python")

    await expect(h?.caller.python.options({ workspaceId })).resolves.toEqual([
      {
        path: join(workspaceDir, ".venv"),
        displayName: "repo/.venv (3.13)",
        interpreterPath: join(workspaceDir, ".venv/bin/python"),
      },
      {
        path: condaPath,
        displayName: "Conda · research (3.12)",
        interpreterPath,
      },
    ])
    expect(resolverCalls).toEqual([
      null,
      join(workspaceDir, ".venv"),
      join(workspaceDir, "venv"),
      condaPath,
      poetryAlias,
      brokenPath,
    ])
  })

  test("keeps an auto-detected Windows manager-root environment first", async () => {
    const environmentPath = String.raw`C:\Users\Ada\miniforge3`
    const currentInterpreter = String.raw`C:\Users\Ada\miniforge3\python.exe`
    const { workspaceId } = await setup(async (_cwd, selectedPath) => {
      if (selectedPath === null) {
        return {
          source: "conda",
          displayName: "miniforge3 (3.13)",
          interpreterPath: currentInterpreter,
          runStrategy: { kind: "environment", command: currentInterpreter, argsPrefix: [] },
        }
      }
      if (selectedPath === environmentPath) {
        return {
          source: "selected",
          displayName: "miniforge3 (3.13)",
          interpreterPath: process.execPath,
          runStrategy: { kind: "environment", command: process.execPath, argsPrefix: [] },
        }
      }
      return NODE_RUNTIME
    })

    await expect(h?.caller.python.options({ workspaceId })).resolves.toEqual([
      {
        path: environmentPath,
        displayName: "miniforge3 (3.13)",
        interpreterPath: process.execPath,
      },
    ])
  })

  test("skips global candidates that disappear after validation", async () => {
    let missingPath = ""
    let notDirectoryPath = ""
    const { workspaceId, workspaceDir } = await setup(
      async (_cwd, selectedPath) => {
        if (selectedPath === missingPath || selectedPath === notDirectoryPath) {
          const interpreterPath =
            selectedPath === missingPath
              ? join(selectedPath, "bin/python")
              : join(selectedPath, "python")
          return {
            source: "selected",
            displayName: "raced (3.13)",
            interpreterPath,
            runStrategy: { kind: "environment", command: interpreterPath, argsPrefix: [] },
          }
        }
        return NODE_RUNTIME
      },
      async () => [
        { manager: "pyenv", path: missingPath, environmentName: "missing" },
        { manager: "uv", path: notDirectoryPath, environmentName: "not-directory" },
      ],
    )
    missingPath = join(workspaceDir, "missing-after-probe")
    notDirectoryPath = join(workspaceDir, "not-a-directory")
    await writeFile(notDirectoryPath, "file, not environment\n")

    await expect(h?.caller.python.options({ workspaceId })).resolves.toEqual([])
  })

  test("runs global discovery only for the chooser query", async () => {
    let discoveryCalls = 0
    const { workspaceId } = await setup(
      async () => NODE_RUNTIME,
      async () => {
        discoveryCalls += 1
        return []
      },
    )

    await h?.caller.python.resolve({ workspaceId })
    await h?.caller.python.resolveLocal({ workspaceId })
    expect(discoveryCalls).toBe(0)

    await h?.caller.python.options({ workspaceId })
    expect(discoveryCalls).toBe(1)
  })

  test("rejects relative or invalid manual environment selections", async () => {
    const { workspaceId } = await setup(async () => NODE_RUNTIME)

    await expect(h?.caller.python.select({ workspaceId, path: ".venv" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    await expect(
      h?.caller.python.select({ workspaceId, path: "/missing/python" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
  })
})

describe("python.runFile", () => {
  test("launches the saved file through the real daemon and streams its output", async () => {
    const { workspaceId, workspaceDir } = await setup(async () => NODE_RUNTIME)
    await writeFile(
      join(workspaceDir, "run.py"),
      "process.stdout.write('PYTHON-RUN-OK'); setInterval(() => {}, 1000)\n",
    )

    const result = await h?.caller.python.runFile({
      workspaceId,
      relPath: "run.py",
      cols: 91,
      rows: 37,
    })
    if (!result || !h) throw new Error("Run did not return a session")
    const output = await collect(result.sessionId)
    await waitFor(() => output.chunks.join("").includes("PYTHON-RUN-OK"))

    expect(output.chunks.join("")).toContain("PYTHON-RUN-OK")
    const session = (await h.caller.terminal.list()).find(({ id }) => id === result.sessionId)
    expect(session).toMatchObject({
      command: process.execPath,
      args: ["run.py"],
      cwd: workspaceDir,
      cols: 91,
      rows: 37,
    })
    expect(result.runtime).toEqual(NODE_RUNTIME)

    await h.caller.terminal.kill({ sessionId: result.sessionId })
    await waitFor(() => output.exits.length > 0)
  })

  test("passes the strategy prefix and file as exact argv without shell interpretation", async () => {
    const selectedPath = "/fixture/manual-python"
    const runtime: PythonRuntime = {
      ...NODE_RUNTIME,
      source: "selected",
      displayName: "manual-python",
      runStrategy: {
        kind: "python",
        command: process.execPath,
        argsPrefix: ["--trace-warnings"],
      },
    }
    const resolverCalls: Array<string | null> = []
    const { workspaceId, workspaceDir } = await setup(async (_cwd, path) => {
      resolverCalls.push(path)
      return path === selectedPath ? runtime : NODE_RUNTIME
    })
    await h?.caller.python.select({ workspaceId, path: selectedPath })
    resolverCalls.length = 0
    const relPath = "safe;touch SHOULD_NOT_EXIST.py"
    await writeFile(
      join(workspaceDir, relPath),
      "process.stdout.write('ARGV-SAFE'); setInterval(() => {}, 1000)\n",
    )

    const result = await h?.caller.python.runFile({
      workspaceId,
      relPath,
      cols: 80,
      rows: 24,
    })
    if (!result || !h) throw new Error("Run did not return a session")
    const session = (await h.caller.terminal.list()).find(({ id }) => id === result.sessionId)

    expect(session?.args).toEqual(["--trace-warnings", relPath])
    expect(result.runtime).toEqual(runtime)
    expect(resolverCalls).toEqual([selectedPath])
    await expect(access(join(workspaceDir, "SHOULD_NOT_EXIST.py"))).rejects.toBeDefined()
    await h.caller.terminal.kill({ sessionId: result.sessionId })
  })

  test("rejects lexical and absolute workspace escapes before resolving a runtime", async () => {
    const resolverCalls: string[] = []
    const { workspaceId } = await setup(async (cwd) => {
      resolverCalls.push(cwd)
      return NODE_RUNTIME
    })

    await expect(
      h?.caller.python.runFile({
        workspaceId,
        relPath: "../outside.py",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h?.caller.python.runFile({
        workspaceId,
        relPath: "/tmp/outside.py",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(resolverCalls).toEqual([])
  })

  test("rejects a symlink whose real target escapes the workspace", async () => {
    const { workspaceId, workspaceDir } = await setup(async () => NODE_RUNTIME)
    if (!h) throw new Error("Harness is not initialized")
    const outside = join(h.dataDir, "outside.py")
    await writeFile(outside, "process.stdout.write('ESCAPED')\n")
    await symlink(outside, join(workspaceDir, "linked.py"))

    await expect(
      h.caller.python.runFile({
        workspaceId,
        relPath: "linked.py",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  test("rejects directories, non-Python files, and an unavailable runtime", async () => {
    const unavailable: PythonRuntime = {
      source: null,
      displayName: "No virtual env",
      interpreterPath: null,
      runStrategy: { kind: "unavailable", command: null, argsPrefix: [] },
    }
    const { workspaceId, workspaceDir } = await setup(async () => unavailable)
    await writeFile(join(workspaceDir, "notes.txt"), "not python\n")
    await writeFile(join(workspaceDir, "valid.py"), "print('unavailable')\n")

    await expect(
      h?.caller.python.runFile({
        workspaceId,
        relPath: ".git",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(
      h?.caller.python.runFile({
        workspaceId,
        relPath: "notes.txt",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(
      h?.caller.python.runFile({
        workspaceId,
        relPath: "valid.py",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
  })
})
