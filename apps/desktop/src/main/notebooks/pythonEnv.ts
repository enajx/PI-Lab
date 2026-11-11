import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"
import { delimiter, isAbsolute, join, relative } from "node:path"
import { interpreterCandidates } from "../python/runtime"

/**
 * Chooses which Python runs a notebook tool (marimo, Jupyter), for marimo and
 * Jupyter servers and for Quarto Python code blocks.
 *
 * Order: the project's own environment when it can already import the tool (so
 * notebooks can import the project's code), then the uv project's environment
 * through `uv run` when its lock file has the tool, else a PI Lab copy through
 * `uvx` that installs nothing in the project. With no uv at all, the result says
 * so and how to install it.
 */
export type PythonTool = "marimo" | "jupyter"

export type JupyterApp = "lab" | "notebook"

export type PythonToolEnvironment =
  /** An interpreter in the project's environment that imports the tool. */
  | { kind: "project"; python: string; label: string; jupyterApp: JupyterApp | null }
  /** The uv project's environment, run with `uv run`. */
  | { kind: "uv-run"; uv: string; label: string; jupyterApp: JupyterApp | null }
  /** A PI Lab copy of the tool run through `uvx`; nothing is installed in the project. */
  | { kind: "pi-lab"; uvx: string; label: string; jupyterApp: JupyterApp | null }
  /** No project environment has the tool and uv is not installed. */
  | { kind: "no-uv"; message: string }

export interface PythonToolEnvironmentInput {
  projectDir: string
  tool: PythonTool
  /** The workspace's chosen Python environment (folder or interpreter), or null. */
  selectedEnvironmentPath: string | null
  /** PATH-style list of folders where `uv` and `uvx` are looked up. */
  searchPath: string
  platform: NodeJS.Platform
}

export const UV_INSTALL_HINT =
  "Install uv with `curl -LsSf https://astral.sh/uv/install.sh | sh` (macOS, Linux) or `brew install uv`, then try again. See https://docs.astral.sh/uv/getting-started/installation/"

/**
 * Python modules (also the uv.lock package names) whose presence means the tool can
 * run, in order of preference.
 */
const TOOL_MODULES: Record<PythonTool, string[]> = {
  marimo: ["marimo"],
  jupyter: ["jupyterlab", "notebook"],
}

const PROBE_TIMEOUT_MS = 10_000
const MODULE_PROBE_SCRIPT =
  "import importlib.util,json,sys; print(json.dumps([m for m in sys.argv[1:] if importlib.util.find_spec(m)]))"

export async function resolvePythonToolEnvironment(
  input: PythonToolEnvironmentInput,
): Promise<PythonToolEnvironment> {
  const wanted = TOOL_MODULES[input.tool]
  for (const candidate of projectInterpreters(input)) {
    if (!(await isExecutableFile(candidate.python))) continue
    const found = await importableModules(candidate.python, wanted, input.projectDir)
    const app = pickApp(input.tool, found)
    if (app === undefined) continue
    return {
      kind: "project",
      python: candidate.python,
      label: `Project environment (${candidate.name})`,
      jupyterApp: app,
    }
  }

  const locked = await lockedPackages(input.projectDir)
  const lockedApp = pickApp(
    input.tool,
    wanted.filter((name) => locked.has(name)),
  )
  if (lockedApp !== undefined) {
    const uv = await findExecutable("uv", input.searchPath, input.platform)
    if (uv) {
      return { kind: "uv-run", uv, label: "Project uv environment (uv run)", jupyterApp: lockedApp }
    }
  }

  const uvx = await findExecutable("uvx", input.searchPath, input.platform)
  if (!uvx) {
    const name = input.tool === "marimo" ? "marimo" : "Jupyter"
    return {
      kind: "no-uv",
      message: `${name} is not installed in this project's environment, and uv was not found to run a PI Lab copy. ${UV_INSTALL_HINT}`,
    }
  }
  return {
    kind: "pi-lab",
    uvx,
    label: "PI Lab copy (uvx)",
    jupyterApp: input.tool === "jupyter" ? "lab" : null,
  }
}

/** True when `uv add` can add a tool to the project: it has a pyproject.toml. */
export async function canAddToolToProject(projectDir: string): Promise<boolean> {
  return isFile(join(projectDir, "pyproject.toml"))
}

/** The `uv add` arguments that add a tool to the project as a dev dependency. */
export function addToolArgs(tool: PythonTool): string[] {
  return tool === "marimo"
    ? ["add", "--dev", "marimo"]
    : ["add", "--dev", "jupyterlab", "ipykernel"]
}

/** Find an executable by name in a PATH-style folder list, or null. */
export async function findExecutable(
  name: string,
  searchPath: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name]
  for (const dir of searchPath.split(delimiter).filter(Boolean)) {
    for (const candidate of names) {
      const path = join(dir, candidate)
      if (await isExecutableFile(path)) return path
    }
  }
  return null
}

/** `undefined`: the tool is missing; otherwise the Jupyter app to start (null for marimo). */
function pickApp(tool: PythonTool, found: readonly string[]): JupyterApp | null | undefined {
  if (tool === "marimo") return found.includes("marimo") ? null : undefined
  if (found.includes("jupyterlab")) return "lab"
  if (found.includes("notebook")) return "notebook"
  return undefined
}

function projectInterpreters(
  input: PythonToolEnvironmentInput,
): Array<{ name: string; python: string }> {
  const result: Array<{ name: string; python: string }> = []
  const selected = input.selectedEnvironmentPath
  if (selected && isAbsolute(selected)) {
    const name = relativeName(input.projectDir, selected)
    result.push({ name, python: selected })
    for (const python of interpreterCandidates(selected, input.platform)) {
      result.push({ name, python })
    }
  }
  for (const envName of [".venv", "venv"]) {
    for (const python of interpreterCandidates(join(input.projectDir, envName), input.platform)) {
      result.push({ name: envName, python })
    }
  }
  return result
}

function relativeName(projectDir: string, path: string): string {
  const rel = relative(projectDir, path)
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path
}

function importableModules(python: string, modules: string[], cwd: string): Promise<string[]> {
  return new Promise((resolveModules) => {
    execFile(
      python,
      ["-c", MODULE_PROBE_SCRIPT, ...modules],
      { cwd, timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          resolveModules([])
          return
        }
        resolveModules(parseModuleList(stdout))
      },
    )
  })
}

function parseModuleList(stdout: string): string[] {
  const line = stdout.trim().split(/\r?\n/).at(-1) ?? ""
  if (!line.startsWith("[")) return []
  const parsed: unknown = JSON.parse(line)
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []
}

/** Package names listed in the project's uv.lock (empty when there is no lock file). */
async function lockedPackages(projectDir: string): Promise<Set<string>> {
  const lock = join(projectDir, "uv.lock")
  if (!(await isFile(lock))) return new Set()
  const text = await readFile(lock, "utf8")
  return new Set([...text.matchAll(/^name = "([^"]+)"/gm)].map((match) => match[1] ?? ""))
}

async function isFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null)
  return info?.isFile() ?? false
}

async function isExecutableFile(path: string): Promise<boolean> {
  if (!(await isFile(path))) return false
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  )
}
