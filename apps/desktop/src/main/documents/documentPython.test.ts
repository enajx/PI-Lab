import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { UV_INSTALL_HINT } from "../notebooks/pythonEnv"
import { documentPython, hasPythonCode, withDocumentPython } from "./documentPython"

/**
 * Which Python runs Quarto and MyST code blocks. Every `python`, `uv` and `uvx`
 * here is a stand-in shell script (not the real tool): a stand-in python prints
 * the JSON list of modules it "can import", the way the real probe reports them.
 */

let projectDir: string
let binDir: string
let venvDir: string

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "pi-lab-doc-python-"))
  binDir = await mkdtemp(join(tmpdir(), "pi-lab-doc-python-bin-"))
  venvDir = join(await mkdtemp(join(tmpdir(), "pi-lab-doc-python-tools-")), "python-jupyter")
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
  await rm(binDir, { recursive: true, force: true })
  await rm(dirname(venvDir), { recursive: true, force: true })
})

const JUPYTER_MODULES = ["jupyterlab", "notebook", "jupyter_core", "ipykernel", "jupyter_server"]

async function writeScript(path: string, body: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

function standInPython(path: string, modules: string[]): Promise<string> {
  return writeScript(path, `echo '${JSON.stringify(modules)}'`)
}

/** Stand-in uv and uvx on a private PATH; uv appends each call to `uv-calls.log`. */
async function standInUv(body: string): Promise<void> {
  await writeScript(join(binDir, "uvx"), "exit 0")
  await writeScript(join(binDir, "uv"), `echo "$*" >> "${binDir}/uv-calls.log"\n${body}`)
}

async function uvCalls(): Promise<string[]> {
  const text = await readFile(join(binDir, "uv-calls.log"), "utf8")
  return text.trim().split("\n")
}

/**
 * Stand-in uv that makes a venv: `uv venv <dir>` copies a stand-in python into
 * `<dir>/bin/python`, which imports Jupyter only after `uv pip install` ran.
 * `uv run ...` prints `uvRunPython` (when given) as the project environment's interpreter.
 */
async function standInVenvMakingUv(uvRunPython: string | null): Promise<void> {
  const template = await writeScript(
    join(binDir, "python-template"),
    `if [ -f "$(dirname "$0")/../installed" ]; then echo '${JSON.stringify(JUPYTER_MODULES)}'; else echo '[]'; fi`,
  )
  await standInUv(
    [
      uvRunPython ? `if [ "$1" = "run" ]; then echo "${uvRunPython}"; exit 0; fi` : "",
      'if [ "$1" = "venv" ]; then mkdir -p "$2/bin" && cp "' +
        template +
        '" "$2/bin/python"; exit 0; fi',
      'if [ "$1" = "pip" ]; then touch "$(dirname "$4")/../installed"; echo "Installed jupyter ipykernel"; exit 0; fi',
      "exit 1",
    ].join("\n"),
  )
}

function choose() {
  return documentPython({
    projectDir,
    venvDir,
    searchPath: binDir,
    platform: process.platform,
    env: { PATH: `${binDir}:/usr/bin:/bin` },
  })
}

describe("documentPython", () => {
  test("uses the project's .venv when it has Jupyter (stand-in python)", async () => {
    const python = await standInPython(join(projectDir, ".venv", "bin", "python"), JUPYTER_MODULES)

    const chosen = await choose()

    expect(chosen.python).toBe(python)
    expect(chosen.log).toContain(python)
  })

  test("uses the uv project's environment when its lock file has Jupyter (stand-in uv and python)", async () => {
    await writeFile(join(projectDir, "uv.lock"), 'name = "jupyterlab"\n')
    const python = await standInPython(join(binDir, "uvenv", "bin", "python"), JUPYTER_MODULES)
    await standInUv(`if [ "$1" = "run" ]; then echo "${python}"; exit 0; fi\nexit 1`)

    const chosen = await choose()

    expect(chosen.python).toBe(python)
    expect((await uvCalls())[0]).toContain("run")
  })

  test("uses the PI Lab venv when the uv project's environment lacks ipykernel (stand-in uv and python)", async () => {
    await writeFile(join(projectDir, "uv.lock"), 'name = "jupyterlab"\n')
    const python = await standInPython(join(binDir, "uvenv", "bin", "python"), ["jupyterlab"])
    await standInVenvMakingUv(python)

    const chosen = await choose()

    expect(chosen.python).toBe(join(venvDir, "bin", "python"))
  })

  test("makes the PI Lab venv once and reuses it (stand-in uv and python)", async () => {
    await standInVenvMakingUv(null)

    const first = await choose()
    const second = await choose()

    expect(first.python).toBe(join(venvDir, "bin", "python"))
    expect(second.python).toBe(first.python)
    expect(first.log).toContain("Installed jupyter ipykernel")
    const calls = await uvCalls()
    expect(calls.filter((call) => call.startsWith("venv"))).toEqual([`venv ${venvDir}`])
    expect(calls.filter((call) => call.startsWith("pip"))).toEqual([
      `pip install --python ${join(venvDir, "bin", "python")} jupyter ipykernel`,
    ])
  })

  test("a failed venv creation shows its output in the log (stand-in uv)", async () => {
    await standInUv('echo "error: no network to download Python" >&2\nexit 2')

    const chosen = await choose()

    expect(chosen.python).toBeNull()
    expect(chosen.log).toContain("error: no network to download Python")
    expect(chosen.log).toContain("exit code 2")
  })

  test("without uv and without a project environment, the log has the uv install hint", async () => {
    const chosen = await choose()

    expect(chosen.python).toBeNull()
    expect(chosen.log).toContain(UV_INSTALL_HINT)
  })
})

describe("hasPythonCode", () => {
  test("finds Quarto python blocks and MyST code cells", () => {
    expect(hasPythonCode("quarto", "# A\n\n```{python}\nprint(1)\n```\n")).toBe(true)
    expect(hasPythonCode("quarto", "# A\n\n```python\nprint(1)\n```\n")).toBe(false)
    expect(hasPythonCode("myst", "# A\n\n```{code-cell} python\nprint(1)\n```\n")).toBe(true)
    expect(hasPythonCode("myst", "# A\n\n```python\nprint(1)\n```\n")).toBe(false)
  })
})

describe("withDocumentPython", () => {
  test("sets QUARTO_PYTHON and puts the interpreter's folder first on PATH", () => {
    expect(withDocumentPython({ PATH: "/usr/bin" }, "/env/bin/python")).toEqual({
      PATH: `/env/bin${process.platform === "win32" ? ";" : ":"}/usr/bin`,
      QUARTO_PYTHON: "/env/bin/python",
    })
    expect(withDocumentPython({ PATH: "/usr/bin" }, null)).toEqual({ PATH: "/usr/bin" })
  })
})
