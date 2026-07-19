import { delimiter, dirname, join } from "node:path"
import { describe, expect, test } from "vitest"
import type { PythonRuntime } from "../python"
import { createPyToolsExec, type PyToolCommandExec, type PyToolExecResult } from "./pyToolsExec"

const MISSING: PyToolExecResult = {
  stdout: "",
  stderr: "",
  code: null,
  notFound: true,
}
const FOUND: PyToolExecResult = {
  stdout: "tool output",
  stderr: "",
  code: 0,
  notFound: false,
}

type CommandCall = Parameters<PyToolCommandExec>[0]

function environmentRuntime(interpreterPath: string): PythonRuntime {
  return {
    source: "dot-venv",
    displayName: ".venv",
    interpreterPath,
    runStrategy: { kind: "environment", command: interpreterPath, argsPrefix: [] },
  }
}

function harness(params: {
  response: (call: CommandCall) => PyToolExecResult
  executableExists?: (path: string) => boolean
  platform?: NodeJS.Platform
}): { exec: ReturnType<typeof createPyToolsExec>; calls: CommandCall[] } {
  const calls: CommandCall[] = []
  const commandExec: PyToolCommandExec = async (call) => {
    calls.push(call)
    return params.response(call)
  }
  return {
    exec: createPyToolsExec({
      commandExec,
      executableExists: params.executableExists ?? (() => false),
      platform: params.platform ?? "linux",
      env: { PATH: "/base/bin", FIXTURE: "kept" },
    }),
    calls,
  }
}

describe("createPyToolsExec fallback order", () => {
  test("uses the detected-environment executable before PATH", async () => {
    const interpreter = "/work/.venv/bin/python"
    const environmentTool = "/work/.venv/bin/ruff"
    const { exec, calls } = harness({
      executableExists: (path) => path === environmentTool,
      response: () => FOUND,
    })

    const result = await exec({
      tool: "ruff",
      args: ["check", "app.py"],
      cwd: "/work",
      runtime: environmentRuntime(interpreter),
    })

    expect(result).toBe(FOUND)
    expect(calls).toEqual([
      {
        command: environmentTool,
        args: ["check", "app.py"],
        cwd: "/work",
        env: {
          PATH: `/work/.venv/bin${delimiter}/base/bin`,
          VIRTUAL_ENV: "/work/.venv",
          FIXTURE: "kept",
        },
      },
    ])
  })

  test("uses the PATH executable when the environment has no matching tool", async () => {
    const { exec, calls } = harness({
      response: (call) => (call.command === "ty" ? FOUND : MISSING),
    })

    const result = await exec({
      tool: "ty",
      args: ["check", "app.py"],
      cwd: "/work",
      runtime: environmentRuntime("/work/.venv/bin/python"),
    })

    expect(result).toBe(FOUND)
    expect(calls.map(({ command }) => command)).toEqual(["ty"])
  })

  test("does not treat a system interpreter as an environment tool directory", async () => {
    const { exec, calls } = harness({
      executableExists: (path) => path === "/usr/bin/ruff",
      response: (call) => (call.command === "ruff" ? FOUND : MISSING),
    })
    const runtime: PythonRuntime = {
      source: null,
      displayName: "No virtual env",
      interpreterPath: "/usr/bin/python3",
      runStrategy: { kind: "python3", command: "/usr/bin/python3", argsPrefix: [] },
    }

    const result = await exec({
      tool: "ruff",
      args: ["check", "app.py"],
      cwd: "/work",
      runtime,
    })

    expect(result).toBe(FOUND)
    expect(calls.map(({ command }) => command)).toEqual(["ruff"])
  })

  test("a manually selected system interpreter does not create a fake virtual environment", async () => {
    const interpreter = "/usr/bin/python3"
    const { exec, calls } = harness({
      executableExists: (path) => path === "/usr/bin/ruff",
      response: (call) => (call.command === "uvx" ? FOUND : MISSING),
    })
    const runtime: PythonRuntime = {
      source: "selected",
      displayName: "usr",
      interpreterPath: interpreter,
      runStrategy: { kind: "environment", command: interpreter, argsPrefix: [] },
    }

    const result = await exec({
      tool: "ruff",
      args: ["check", "app.py"],
      cwd: "/work",
      runtime,
    })

    expect(result).toBe(FOUND)
    expect(calls.map(({ command }) => command)).toEqual(["ruff", "uvx"])
    expect(calls[0]?.env).toEqual({ PATH: "/base/bin", FIXTURE: "kept" })
    expect(calls[1]?.args).toEqual(["--python", interpreter, "ruff", "check", "app.py"])
  })

  test("continues to PATH when a detected environment executable cannot launch", async () => {
    const environmentTool = "/work/.venv/bin/pyrefly"
    const { exec, calls } = harness({
      executableExists: (path) => path === environmentTool,
      response: (call) => (call.command === environmentTool ? MISSING : FOUND),
    })

    const result = await exec({
      tool: "pyrefly",
      args: ["check", "app.py"],
      cwd: "/work",
      runtime: environmentRuntime("/work/.venv/bin/python"),
    })

    expect(result).toBe(FOUND)
    expect(calls.map(({ command }) => command)).toEqual([environmentTool, "pyrefly"])
  })

  test("falls back to uvx and selects the detected interpreter", async () => {
    const interpreter = "/work/.venv/bin/python"
    const { exec, calls } = harness({
      response: (call) => (call.command === "uvx" ? FOUND : MISSING),
    })

    const result = await exec({
      tool: "pyrefly",
      args: ["check", "--output-format", "json", "app.py"],
      cwd: "/work",
      runtime: environmentRuntime(interpreter),
    })

    expect(result).toBe(FOUND)
    expect(calls.map(({ command }) => command)).toEqual(["pyrefly", "uvx"])
    expect(calls[1]?.args).toEqual([
      "--python",
      interpreter,
      "pyrefly",
      "check",
      "--output-format",
      "json",
      "app.py",
    ])
  })

  test("uses the Windows Scripts executable name when requested", async () => {
    const interpreter = String.raw`C:\work\.venv\Scripts\python.exe`
    const expectedTool = join(dirname(interpreter), "ruff.exe")
    const { exec, calls } = harness({
      platform: "win32",
      executableExists: (path) => path === expectedTool,
      response: () => FOUND,
    })

    await exec({
      tool: "ruff",
      args: ["format", "app.py"],
      cwd: String.raw`C:\work`,
      runtime: environmentRuntime(interpreter),
    })

    expect(calls[0]?.command).toBe(expectedTool)
  })

  test("preserves the explicit unavailable outcome when PATH and uvx are absent", async () => {
    const { exec, calls } = harness({ response: () => MISSING })

    const result = await exec({
      tool: "ruff",
      args: ["format", "app.py"],
      cwd: "/work",
    })

    expect(result).toEqual(MISSING)
    expect(calls.map(({ command }) => command)).toEqual(["ruff", "uvx"])
    expect(calls[1]?.args).toEqual(["ruff", "format", "app.py"])
  })
})
