import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"
import {
  findExecutable,
  importableModules,
  resolvePythonToolEnvironment,
  UV_INSTALL_HINT,
} from "../notebooks/pythonEnv"
import type { DocumentTool } from "./tools"

/**
 * Chooses the Python that runs Quarto and MyST code blocks: the project's
 * environment when it has Jupyter (its `.venv`, or the uv project's environment
 * through `uv run`), else a PI Lab venv in `<PI Lab data dir>/tools/python-jupyter`
 * made with uv on first need and reused after. Nothing is installed in the project.
 */

/** The PI Lab venv's folder name inside PI Lab's tools folder. */
export const PI_LAB_JUPYTER_VENV = "python-jupyter"

/** Modules a Python needs to run code blocks: Quarto uses the kernel, MyST starts a Jupyter server. */
const KERNEL_MODULES = ["jupyter_core", "ipykernel", "jupyter_server"]
const KERNEL_PACKAGES = ["jupyter", "ipykernel"]
/** Making the venv downloads packages; stop it after 10 minutes. */
const UV_TIMEOUT_MS = 10 * 60_000

export interface DocumentPythonInput {
  projectDir: string
  /** Where the PI Lab venv lives (`<PI Lab data dir>/tools/python-jupyter`). */
  venvDir: string
  /** PATH-style list of folders where `uv` and `uvx` are looked up. */
  searchPath: string
  platform: NodeJS.Platform
  /** Environment for the `uv` runs. */
  env: Record<string, string>
}

/** The chosen interpreter (null: none, let the tool pick) and what happened, for the render log. */
export interface DocumentPython {
  python: string | null
  log: string
}

/** True when the document has code blocks that run in Python: Quarto `{python}` blocks, MyST `{code-cell}`s. */
export function hasPythonCode(tool: DocumentTool, text: string): boolean {
  if (tool === "quarto") return /^\s*(`{3,}|~{3,})\s*\{python[\s,}]/m.test(text)
  return /^\s*(`{3,}|~{3,}|:{3,})\s*\{code-cell\}/m.test(text)
}

/** `env` with QUARTO_PYTHON set to `python` and its folder first on PATH (MyST finds Jupyter there). */
export function withDocumentPython(
  env: Record<string, string>,
  python: string | null,
): Record<string, string> {
  if (python === null) return env
  return {
    ...env,
    QUARTO_PYTHON: python,
    PATH: `${dirname(python)}${delimiter}${env.PATH ?? ""}`,
  }
}

export async function documentPython(input: DocumentPythonInput): Promise<DocumentPython> {
  const environment = await resolvePythonToolEnvironment({
    projectDir: input.projectDir,
    tool: "jupyter",
    selectedEnvironmentPath: null,
    searchPath: input.searchPath,
    platform: input.platform,
  })
  const notes: string[] = []
  if (environment.kind === "project") {
    if (await hasKernel(environment.python, input.projectDir)) {
      return { python: environment.python, log: chosenLine(environment.label, environment.python) }
    }
    notes.push(`${environment.label} at ${environment.python} lacks ${KERNEL_MODULES.join(", ")}.`)
  }
  if (environment.kind === "uv-run") {
    const found = await run(
      environment.uv,
      ["run", "--project", input.projectDir, "python", "-c", "import sys; print(sys.executable)"],
      input.projectDir,
      input.env,
    )
    const python = found.stdout.trim().split(/\r?\n/).at(-1) ?? ""
    if (found.code === 0 && python && (await hasKernel(python, input.projectDir))) {
      return { python, log: chosenLine(environment.label, python) }
    }
    notes.push(
      found.code === 0
        ? `${environment.label} at ${python} lacks ${KERNEL_MODULES.join(", ")}.`
        : `${found.output.trimEnd()}\nuv run in the project ${found.status}.`,
    )
  }
  const uv = await findExecutable("uv", input.searchPath, input.platform)
  if (!uv) {
    notes.push(
      `Python code blocks need Jupyter, which this project's environment does not have, and uv was not found to make a PI Lab Python. Rendering without a chosen Python. ${UV_INSTALL_HINT}`,
    )
    return { python: null, log: notes.join("\n") }
  }
  const made = await piLabPython(uv, input)
  return { python: made.python, log: [...notes, made.log].join("\n") }
}

const pending = new Map<string, Promise<DocumentPython>>()

/** The PI Lab venv's Python, made on first need. Renders at the same time share one run. */
function piLabPython(uv: string, input: DocumentPythonInput): Promise<DocumentPython> {
  const running = pending.get(input.venvDir)
  if (running) return running
  const job = makePiLabPython(uv, input).finally(() => pending.delete(input.venvDir))
  pending.set(input.venvDir, job)
  return job
}

async function makePiLabPython(uv: string, input: DocumentPythonInput): Promise<DocumentPython> {
  const label = "PI Lab Python"
  const python =
    input.platform === "win32"
      ? join(input.venvDir, "Scripts", "python.exe")
      : join(input.venvDir, "bin", "python")
  if (existsSync(python) && (await hasKernel(python, input.venvDir))) {
    return { python, log: chosenLine(label, python) }
  }
  await rm(input.venvDir, { recursive: true, force: true })
  await mkdir(dirname(input.venvDir), { recursive: true })
  const steps: Array<{ args: string[] }> = [
    { args: ["venv", input.venvDir] },
    { args: ["pip", "install", "--python", python, ...KERNEL_PACKAGES] },
  ]
  const logs = [`Making the ${label} for code blocks at ${input.venvDir}.`]
  for (const step of steps) {
    const result = await run(uv, step.args, dirname(input.venvDir), input.env)
    logs.push(result.output.trimEnd())
    if (result.code !== 0) {
      logs.push(`uv ${step.args.join(" ")} ${result.status}. Rendering without a chosen Python.`)
      return { python: null, log: logs.join("\n") }
    }
  }
  if (!(await hasKernel(python, input.venvDir))) {
    logs.push(
      `${python} still lacks ${KERNEL_MODULES.join(", ")}. Rendering without a chosen Python.`,
    )
    return { python: null, log: logs.join("\n") }
  }
  logs.push(chosenLine(label, python))
  return { python, log: logs.join("\n") }
}

function chosenLine(label: string, python: string): string {
  return `Python for code blocks: ${label}, ${python}`
}

async function hasKernel(python: string, cwd: string): Promise<boolean> {
  const found = await importableModules(python, KERNEL_MODULES, cwd)
  return KERNEL_MODULES.every((name) => found.includes(name))
}

interface RunResult {
  code: number | null
  stdout: string
  /** stdout and stderr together. */
  output: string
  /** "failed with exit code N" or "did not finish", for the log. */
  status: string
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolveRun) => {
    execFile(
      command,
      args,
      { cwd, env, timeout: UV_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const failedToRun = error !== null && typeof error.code !== "number"
        const output = `${stdout}${stderr}${failedToRun ? `\n${error.message}` : ""}`
        if (!error) {
          resolveRun({ code: 0, stdout, output, status: "worked" })
          return
        }
        const code = typeof error.code === "number" ? error.code : null
        resolveRun({
          code,
          stdout,
          output,
          status: code === null ? "did not finish" : `failed with exit code ${code}`,
        })
      },
    )
  })
}
