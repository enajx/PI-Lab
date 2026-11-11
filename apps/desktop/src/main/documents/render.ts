import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, sep } from "node:path"
import { isGitRepo, repoRoot } from "../git"
import { addLocalExclude } from "../git/remote"
import type { DocumentTool } from "./tools"

/**
 * Render a Quarto (.qmd) or MyST (.md) file to HTML with the real CLI. The
 * output goes to `_render/<file name>/` next to the file; that `_render` folder
 * is added to the repo's local `.git/info/exclude`. Code blocks run during
 * render (`quarto render` runs them by default; MyST gets `--execute`); the
 * Python for them is chosen in `documentPython.ts`.
 */

/** The build folder made next to a rendered file. */
export const RENDER_FOLDER = "_render"

/** A render run: the command, its working folder, files to write first, and the expected HTML. */
export interface RenderPlan {
  command: string
  args: string[]
  cwd: string
  setupFiles: { path: string; content: string }[]
  outputPath: string
}

/**
 * The command that renders `absFile` with `tool` at `toolPath`.
 * Quarto: `quarto render <name> --to html --output-dir _render/<name>`, run in
 * the file's folder, writes `_render/<name>/<stem>.html`.
 * MyST: mystmd builds HTML only for a project, so PI Lab writes a one-page
 * `_render/<name>/myst.yml` (its table of contents points at the file) and runs
 * `myst build --html --execute --ci` there, which writes
 * `_render/<name>/_build/html/index.html`.
 */
export function renderPlan(tool: DocumentTool, toolPath: string, absFile: string): RenderPlan {
  const name = basename(absFile)
  const fileDir = dirname(absFile)
  const outputDir = join(fileDir, RENDER_FOLDER, name)
  if (tool === "quarto") {
    const stem = name.replace(/\.[^.]+$/, "")
    return {
      command: toolPath,
      args: ["render", name, "--to", "html", "--output-dir", `${RENDER_FOLDER}/${name}`],
      cwd: fileDir,
      setupFiles: [],
      outputPath: join(outputDir, `${stem}.html`),
    }
  }
  const config = [
    "# Written by PI Lab to render one file with MyST. PI Lab rewrites it on each render.",
    "version: 1",
    "project:",
    "  toc:",
    `    - file: ${JSON.stringify(`../../${name}`)}`,
    "site:",
    "  template: book-theme",
    "",
  ].join("\n")
  return {
    command: toolPath,
    args: ["build", "--html", "--execute", "--ci"],
    cwd: outputDir,
    setupFiles: [{ path: join(outputDir, "myst.yml"), content: config }],
    outputPath: join(outputDir, "_build", "html", "index.html"),
  }
}

/**
 * Add the `_render` folder next to `absFile` to the repo's `.git/info/exclude`
 * (as `/<folder from the repo root>/_render/`). Does nothing outside a Git repo.
 */
export async function excludeRenderFolder(absFile: string): Promise<void> {
  const fileDir = dirname(absFile)
  if (!(await isGitRepo(fileDir))) return
  const root = await realpath(await repoRoot(fileDir))
  const rel = relative(root, join(await realpath(fileDir), RENDER_FOLDER))
    .split(sep)
    .join("/")
  await addLocalExclude(fileDir, `/${rel}/`)
}

/** The outcome of a render. `log` holds the tool's output, and the reason when it failed. */
export interface RenderOutcome {
  ok: boolean
  log: string
  outputPath: string | null
}

/** Keep only the end of a long log. */
const MAX_LOG = 200_000

/**
 * Run `plan`: write its setup files, remove an old output so a failed run never
 * shows a stale page, run the command without a shell, and report the result.
 * A run is ok only when the command exits 0 and wrote the expected HTML.
 */
export async function runRender(
  plan: RenderPlan,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<RenderOutcome> {
  await mkdir(plan.cwd, { recursive: true })
  for (const file of plan.setupFiles) await writeFile(file.path, file.content)
  await rm(plan.outputPath, { force: true })
  const { code, log } = await new Promise<{ code: number | null; log: string }>((resolveRun) => {
    let output = ""
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-MAX_LOG)
    }
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    })
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    child.on("error", (error) => resolveRun({ code: null, log: `${output}\n${error.message}` }))
    child.on("close", (exitCode, signal) =>
      resolveRun({
        code: exitCode,
        log: exitCode === null ? `${output}\nStopped by signal ${signal}.` : output,
      }),
    )
  })
  const command = `${basename(plan.command)} ${plan.args.join(" ")}`
  if (code !== 0) {
    const status = code === null ? "did not finish" : `failed with exit code ${code}`
    return { ok: false, log: `${log.trimEnd()}\n\n${command} ${status}.`, outputPath: null }
  }
  if (!existsSync(plan.outputPath)) {
    return {
      ok: false,
      log: `${log.trimEnd()}\n\n${command} finished but did not write ${plan.outputPath}.`,
      outputPath: null,
    }
  }
  return { ok: true, log, outputPath: plan.outputPath }
}
