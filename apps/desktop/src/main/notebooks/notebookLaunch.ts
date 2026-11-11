import type { PythonTool, PythonToolEnvironment } from "./pythonEnv"

/** A shell-free command line for one notebook server and the URL that opens the notebook. */
export interface NotebookLaunch {
  command: string
  args: string[]
  url: string
}

export interface NotebookLaunchInput {
  tool: PythonTool
  environment: Exclude<PythonToolEnvironment, { kind: "no-uv" }>
  /** The folder the server runs in (Jupyter's root folder). */
  cwd: string
  absPath: string
  /** The notebook's path relative to `cwd`, with `/` separators. */
  relPath: string
  port: number
  token: string
  /** The renderer's dev server origin (development only), or null. */
  devServerOrigin: string | null
}

export const NOTEBOOK_HOST = "127.0.0.1"

/**
 * Jupyter refuses to be shown in a frame from another origin by default. PI Lab's
 * packaged window is a file:// page, so `file:` is allowed, plus the renderer's dev
 * server origin in development. `'self'` keeps Jupyter's own frames working.
 */
function jupyterFramePolicy(devServerOrigin: string | null): string {
  const ancestors = ["'self'", "file:", ...(devServerOrigin ? [devServerOrigin] : [])]
  return JSON.stringify({
    headers: { "Content-Security-Policy": `frame-ancestors ${ancestors.join(" ")}` },
  })
}

/** Build the command that starts the notebook's server, bound to 127.0.0.1 with a token. */
export function buildNotebookLaunch(input: NotebookLaunchInput): NotebookLaunch {
  const base = `http://${NOTEBOOK_HOST}:${input.port}`
  if (input.tool === "marimo") {
    const sandbox = input.environment.kind === "pi-lab" ? ["--sandbox"] : []
    const toolArgs = [
      "marimo",
      "edit",
      ...sandbox,
      input.absPath,
      "--host",
      NOTEBOOK_HOST,
      "--port",
      String(input.port),
      "--headless",
      "--token-password",
      input.token,
    ]
    return {
      ...commandFor(input.environment, toolArgs, "marimo"),
      url: `${base}/?access_token=${encodeURIComponent(input.token)}`,
    }
  }
  const app = input.environment.jupyterApp ?? "lab"
  const toolArgs = [
    "jupyter",
    app,
    "--no-browser",
    `--ServerApp.ip=${NOTEBOOK_HOST}`,
    `--ServerApp.port=${input.port}`,
    "--ServerApp.port_retries=0",
    `--ServerApp.token=${input.token}`,
    `--ServerApp.root_dir=${input.cwd}`,
    `--ServerApp.tornado_settings=${jupyterFramePolicy(input.devServerOrigin)}`,
  ]
  const path = input.relPath.split("/").map(encodeURIComponent).join("/")
  const route = app === "lab" ? "lab/tree" : "notebooks"
  return {
    ...commandFor(input.environment, toolArgs, "jupyterlab"),
    url: `${base}/${route}/${path}?token=${encodeURIComponent(input.token)}`,
  }
}

/** `toolArgs` starts with the tool's command name (`marimo` or `jupyter`). */
function commandFor(
  environment: NotebookLaunchInput["environment"],
  toolArgs: string[],
  uvxPackage: string,
): { command: string; args: string[] } {
  switch (environment.kind) {
    case "project":
      return { command: environment.python, args: ["-m", ...toolArgs] }
    case "uv-run":
      return { command: environment.uv, args: ["run", ...toolArgs] }
    case "pi-lab":
      return {
        command: environment.uvx,
        args: toolArgs[0] === uvxPackage ? toolArgs : ["--from", uvxPackage, ...toolArgs],
      }
  }
}
