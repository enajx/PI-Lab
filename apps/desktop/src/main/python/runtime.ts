import { execFile } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path"

export type PythonEnvironmentSource =
  | "dot-venv"
  | "venv"
  | "uv-project"
  | "poetry"
  | "virtual-env"
  | "conda"
  | "selected"

export type PythonRunStrategyKind =
  | "environment"
  | "uv-project"
  | "python3"
  | "python"
  | "unavailable"

export interface PythonRunStrategy {
  kind: PythonRunStrategyKind
  command: string | null
  argsPrefix: string[]
}

/** Workspace-scoped Python runtime information exposed to the renderer. */
export interface PythonRuntime {
  source: PythonEnvironmentSource | null
  displayName: string
  interpreterPath: string | null
  /** Present when a manual interpreter is known to belong to this environment. */
  environmentPath?: string
  runStrategy: PythonRunStrategy
}

export interface PythonProbeResult {
  stdout: string
  stderr: string
  code: number | null
  notFound: boolean
  timedOut: boolean
}

export type PythonProbe = (params: {
  command: string
  args: readonly string[]
  cwd: string
  timeoutMs: number
}) => Promise<PythonProbeResult>

export interface PythonRuntimeResolverOptions {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  probe: PythonProbe
}

export type PythonRuntimeResolver = (
  workspaceDir: string,
  selectedEnvironmentPath: string | null,
) => Promise<PythonRuntime>

const PROBE_TIMEOUT_MS = 3_000
const PYTHON_INFO_SCRIPT =
  "import json,sys; print(json.dumps({'executable':sys.executable,'version':f'{sys.version_info.major}.{sys.version_info.minor}'}))"

export const livePythonProbe: PythonProbe = ({ command, args, cwd, timeoutMs }) =>
  new Promise((resolveProbe) => {
    execFile(
      command,
      [...args],
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        const code =
          typeof (error as NodeJS.ErrnoException | null)?.code === "number"
            ? ((error as unknown as { code: number }).code ?? null)
            : error
              ? null
              : 0
        const errorCode = (error as NodeJS.ErrnoException | null)?.code
        const killed = Boolean((error as { killed?: boolean } | null)?.killed)
        resolveProbe({
          stdout,
          stderr,
          code,
          notFound: errorCode === "ENOENT",
          timedOut: killed || errorCode === "ETIMEDOUT",
        })
      },
    )
  })

export const livePythonRuntimeResolver: PythonRuntimeResolver = (
  workspaceDir,
  selectedEnvironmentPath,
) =>
  resolvePythonRuntime(
    workspaceDir,
    {
      env: process.env,
      platform: process.platform,
      probe: livePythonProbe,
    },
    selectedEnvironmentPath,
  )

/**
 * Honor a persisted manual choice when it is still valid, otherwise retain the
 * safe automatic fallback rather than leaving Python unusable after an
 * environment is moved or deleted.
 */
export async function resolveWorkspacePythonRuntime(
  resolver: PythonRuntimeResolver,
  workspaceDir: string,
  selectedEnvironmentPath: string | null,
): Promise<PythonRuntime> {
  if (selectedEnvironmentPath) {
    const selected = await resolver(workspaceDir, selectedEnvironmentPath)
    if (selected.source === "selected") return selected
  }
  return resolver(workspaceDir, null)
}

/**
 * Resolve an existing environment without creating one or downloading Python.
 * Local environments win over manager and inherited-shell state.
 */
export async function resolvePythonRuntime(
  workspaceDir: string,
  options: PythonRuntimeResolverOptions,
  selectedEnvironmentPath: string | null,
): Promise<PythonRuntime> {
  if (selectedEnvironmentPath) {
    return (
      (await validatedSelectedEnvironment(selectedEnvironmentPath, workspaceDir, options)) ??
      noEnvironment({ kind: "unavailable", command: null, argsPrefix: [] })
    )
  }

  const candidates: Array<{ source: PythonEnvironmentSource; envDir: string }> = [
    { source: "dot-venv", envDir: join(workspaceDir, ".venv") },
    { source: "venv", envDir: join(workspaceDir, "venv") },
  ]

  const configuredUvEnvironment = options.env.UV_PROJECT_ENVIRONMENT
  if (configuredUvEnvironment) {
    candidates.push({
      source: "uv-project",
      envDir: isAbsolute(configuredUvEnvironment)
        ? configuredUvEnvironment
        : resolve(workspaceDir, configuredUvEnvironment),
    })
  }

  for (const candidate of candidates) {
    const runtime = await validatedEnvironment(
      candidate.source,
      candidate.envDir,
      workspaceDir,
      options,
    )
    if (runtime) return runtime
  }

  if (isPoetryProject(workspaceDir)) {
    const poetry = await options.probe({
      command: "poetry",
      args: ["env", "info", "--executable"],
      cwd: workspaceDir,
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    const executable = poetry.stdout.trim().split(/\r?\n/).at(-1) ?? ""
    if (!poetry.notFound && !poetry.timedOut && poetry.code === 0 && executable) {
      const runtime = await validatedInterpreter(
        "poetry",
        executable,
        workspaceDir,
        options,
        environmentDirForInterpreter(executable),
        undefined,
      )
      if (runtime) return runtime
    }
  }

  const inherited: Array<{ source: PythonEnvironmentSource; envDir: string | undefined }> = [
    { source: "virtual-env", envDir: options.env.VIRTUAL_ENV },
    { source: "conda", envDir: options.env.CONDA_PREFIX },
  ]
  for (const candidate of inherited) {
    if (!candidate.envDir) continue
    const runtime = await validatedEnvironment(
      candidate.source,
      candidate.envDir,
      workspaceDir,
      options,
    )
    if (runtime) return runtime
  }

  if (isUvProject(workspaceDir)) {
    const uv = await options.probe({
      command: "uv",
      args: ["--version"],
      cwd: workspaceDir,
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    if (!uv.notFound && !uv.timedOut && uv.code === 0) {
      return noEnvironment({
        kind: "uv-project",
        command: "uv",
        argsPrefix: ["run", "python"],
      })
    }
  }

  for (const command of ["python3", "python"] as const) {
    const probe = await options.probe({
      command,
      args: ["-c", PYTHON_INFO_SCRIPT],
      cwd: workspaceDir,
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    const executable = parsePythonInfo(probe.stdout, command).executable
    if (!probe.notFound && !probe.timedOut && probe.code === 0 && executable) {
      return {
        source: null,
        displayName: "No virtual env",
        interpreterPath: executable,
        runStrategy: { kind: command, command: executable, argsPrefix: [] },
      }
    }
  }

  return noEnvironment({ kind: "unavailable", command: null, argsPrefix: [] })
}

function noEnvironment(runStrategy: PythonRunStrategy): PythonRuntime {
  return {
    source: null,
    displayName: "No virtual env",
    interpreterPath: null,
    runStrategy,
  }
}

async function validatedEnvironment(
  source: PythonEnvironmentSource,
  envDir: string,
  cwd: string,
  options: PythonRuntimeResolverOptions,
  selectedEnvironmentPath?: string,
): Promise<PythonRuntime | null> {
  if (!isDirectory(envDir)) return null
  for (const interpreterPath of interpreterCandidates(envDir, options.platform)) {
    if (!existsSync(interpreterPath)) continue
    const runtime = await validatedInterpreter(
      source,
      interpreterPath,
      cwd,
      options,
      envDir,
      selectedEnvironmentPath,
    )
    if (runtime) return runtime
  }
  return null
}

async function validatedInterpreter(
  source: PythonEnvironmentSource,
  interpreterPath: string,
  cwd: string,
  options: PythonRuntimeResolverOptions,
  envDir: string,
  selectedEnvironmentPath: string | undefined,
): Promise<PythonRuntime | null> {
  const probe = await options.probe({
    command: interpreterPath,
    args: ["-c", PYTHON_INFO_SCRIPT],
    cwd,
    timeoutMs: PROBE_TIMEOUT_MS,
  })
  if (probe.notFound || probe.timedOut || probe.code !== 0) return null
  const python = parsePythonInfo(probe.stdout, interpreterPath)
  const resolvedInterpreter = python.executable
  return {
    source,
    displayName: environmentDisplayName(source, envDir, cwd, python.version),
    interpreterPath: resolvedInterpreter,
    ...(selectedEnvironmentPath ? { environmentPath: selectedEnvironmentPath } : {}),
    runStrategy: { kind: "environment", command: resolvedInterpreter, argsPrefix: [] },
  }
}

async function validatedSelectedEnvironment(
  selectedPath: string,
  cwd: string,
  options: PythonRuntimeResolverOptions,
): Promise<PythonRuntime | null> {
  if (!isAbsolute(selectedPath)) return null
  if (isDirectory(selectedPath)) {
    return validatedEnvironment("selected", selectedPath, cwd, options, selectedPath)
  }
  if (!existsSync(selectedPath) || !statSync(selectedPath).isFile()) return null
  const inferredEnvironmentPath = environmentDirForInterpreter(selectedPath)
  const belongsToEnvironment =
    existsSync(join(inferredEnvironmentPath, "pyvenv.cfg")) ||
    isDirectory(join(inferredEnvironmentPath, "conda-meta"))
  return validatedInterpreter(
    "selected",
    selectedPath,
    cwd,
    options,
    inferredEnvironmentPath,
    belongsToEnvironment ? inferredEnvironmentPath : undefined,
  )
}

/** Both POSIX (`bin/python`) and Windows (`Scripts/python.exe`) virtualenv layouts. */
export function interpreterCandidates(envDir: string, platform: NodeJS.Platform): string[] {
  const windows = [
    join(envDir, "Scripts", "python.exe"),
    join(envDir, "Scripts", "python"),
    join(envDir, "python.exe"),
    join(envDir, "python"),
  ]
  const posix = [join(envDir, "bin", "python3"), join(envDir, "bin", "python")]
  return platform === "win32" ? [...windows, ...posix] : [...posix, ...windows]
}

export function environmentDirForInterpreter(interpreterPath: string): string {
  const windowsPath = /^[A-Za-z]:[\\/]|^\\\\/.test(interpreterPath)
  const paths = windowsPath ? win32 : posix
  const executableDir = paths.dirname(interpreterPath)
  const layoutDir = paths.basename(executableDir).toLowerCase()
  return layoutDir === "bin" || layoutDir === "scripts"
    ? paths.dirname(executableDir)
    : executableDir
}

export function isUvProject(workspaceDir: string): boolean {
  if (existsSync(join(workspaceDir, "uv.lock")) || existsSync(join(workspaceDir, "uv.toml"))) {
    return true
  }
  const pyproject = join(workspaceDir, "pyproject.toml")
  return existsSync(pyproject) && /\[tool\.uv(?:\.|\])/.test(readFileSync(pyproject, "utf8"))
}

function isPoetryProject(workspaceDir: string): boolean {
  const pyproject = join(workspaceDir, "pyproject.toml")
  return existsSync(pyproject) && /\[tool\.poetry(?:\.|\])/.test(readFileSync(pyproject, "utf8"))
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory()
}

function parsePythonInfo(
  stdout: string,
  fallbackExecutable: string,
): {
  executable: string
  version: string | null
} {
  const lastLine = stdout.trim().split(/\r?\n/).at(-1) ?? ""
  if (lastLine.startsWith("{")) {
    const parsed = JSON.parse(lastLine) as { executable?: unknown; version?: unknown }
    return {
      executable:
        typeof parsed.executable === "string" && parsed.executable
          ? parsed.executable
          : fallbackExecutable,
      version: typeof parsed.version === "string" && parsed.version ? parsed.version : null,
    }
  }
  return { executable: lastLine || fallbackExecutable, version: null }
}

function environmentDisplayName(
  source: PythonEnvironmentSource,
  envDir: string,
  workspaceDir: string,
  version: string | null,
): string {
  const envName = basename(envDir) || envDir
  const rel = relative(resolve(workspaceDir), resolve(envDir))
  const projectLocal =
    (source === "dot-venv" ||
      source === "venv" ||
      source === "uv-project" ||
      source === "selected") &&
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  if (!projectLocal) return envName
  const projectEnvironment = `${basename(workspaceDir)}/${envName}`
  return version ? `${projectEnvironment} (${version})` : projectEnvironment
}
