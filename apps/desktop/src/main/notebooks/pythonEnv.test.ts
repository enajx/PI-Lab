import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { resolvePythonToolEnvironment } from "./pythonEnv"

let projectDir: string
let binDir: string

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "pi-lab-python-env-"))
  binDir = await mkdtemp(join(tmpdir(), "pi-lab-python-env-bin-"))
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
  await rm(binDir, { recursive: true, force: true })
})

/** Write an executable shell script (a stand-in for a real tool) and return its path. */
async function writeScript(path: string, body: string): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

/**
 * Stand-in `.venv/bin/python`: it ignores its arguments and prints the JSON list of
 * modules it "can import", the way the real module probe reports them.
 */
async function standInVenvPython(modules: string[]): Promise<string> {
  return writeScript(
    join(projectDir, ".venv", "bin", "python"),
    `echo '${JSON.stringify(modules)}'`,
  )
}

/** Stand-in uv and uvx on a private PATH (they are only looked up, never run here). */
async function standInUv(): Promise<void> {
  await writeScript(join(binDir, "uv"), "exit 0")
  await writeScript(join(binDir, "uvx"), "exit 0")
}

function resolve(tool: "marimo" | "jupyter") {
  return resolvePythonToolEnvironment({
    projectDir,
    tool,
    selectedEnvironmentPath: null,
    searchPath: binDir,
    platform: process.platform,
  })
}

describe("resolvePythonToolEnvironment", () => {
  test("uses the project's .venv when marimo imports there (stand-in python)", async () => {
    const python = await standInVenvPython(["marimo"])
    await expect(resolve("marimo")).resolves.toEqual({
      kind: "project",
      python,
      label: "Project environment (.venv)",
      jupyterApp: null,
    })
  })

  test("prefers JupyterLab over Notebook in the project's .venv (stand-in python)", async () => {
    const python = await standInVenvPython(["notebook", "jupyterlab"])
    await expect(resolve("jupyter")).resolves.toEqual({
      kind: "project",
      python,
      label: "Project environment (.venv)",
      jupyterApp: "lab",
    })
  })

  test("falls back to Jupyter Notebook when JupyterLab is missing (stand-in python)", async () => {
    await standInVenvPython(["notebook"])
    await expect(resolve("jupyter")).resolves.toMatchObject({
      kind: "project",
      jupyterApp: "notebook",
    })
  })

  test("uses a PI Lab copy through uvx when the project's .venv lacks the tool (stand-in python and uvx)", async () => {
    await standInVenvPython(["numpy"])
    await standInUv()
    await expect(resolve("jupyter")).resolves.toEqual({
      kind: "pi-lab",
      uvx: join(binDir, "uvx"),
      label: "PI Lab copy (uvx)",
      jupyterApp: "lab",
      fallbackReason: null,
    })
  })

  test("runs through `uv run` when the uv project's lock file has the tool and there is no .venv (stand-in uv)", async () => {
    await standInUv()
    await writeFile(join(projectDir, "pyproject.toml"), '[project]\nname = "demo"\n')
    await writeFile(
      join(projectDir, "uv.lock"),
      'version = 1\n\n[[package]]\nname = "marimo"\nversion = "0.9.0"\n',
    )
    await expect(resolve("marimo")).resolves.toEqual({
      kind: "uv-run",
      uv: join(binDir, "uv"),
      label: "Project uv environment (uv run)",
      jupyterApp: null,
      fallbackReason: null,
    })
  })

  test("says why it fell back to a PI Lab copy when the project's Python fails to run (stand-in python)", async () => {
    const python = await writeScript(
      join(projectDir, ".venv", "bin", "python"),
      "echo 'dyld: Library not loaded: libpython3.12.dylib' >&2\nexit 6",
    )
    await standInUv()
    const result = await resolve("jupyter")
    expect(result.kind).toBe("pi-lab")
    const reason = result.kind === "pi-lab" ? (result.fallbackReason ?? "") : ""
    expect(reason).toContain(python)
    expect(reason).toContain("dyld: Library not loaded: libpython3.12.dylib")
  })

  test("reports a missing uv with how to install it", async () => {
    const result = await resolve("marimo")
    expect(result.kind).toBe("no-uv")
    expect(result.kind === "no-uv" ? result.message : "").toContain(
      "curl -LsSf https://astral.sh/uv/install.sh | sh",
    )
  })
})
