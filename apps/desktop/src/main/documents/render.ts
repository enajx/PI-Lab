import { existsSync } from "node:fs"
import { mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, sep } from "node:path"
import { isGitRepo, repoRoot } from "../git"
import { addLocalExclude } from "../git/remote"
import { ProcessGroup } from "../runtime/processGroup"
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

/** Quarto's project file names; a folder with one is a Quarto project. */
const QUARTO_PROJECT_FILES = ["_quarto.yml", "_quarto.yaml"]

/**
 * The Quarto project `absFile` belongs to: the nearest folder from the file's
 * folder up to `projectDir` (PI Lab's project folder, included) that has a
 * `_quarto.yml`, or null when there is none.
 */
export function findQuartoProject(absFile: string, projectDir: string): string | null {
  let dir = dirname(absFile)
  while (true) {
    if (QUARTO_PROJECT_FILES.some((name) => existsSync(join(dir, name)))) return dir
    const rel = relative(projectDir, dir)
    if (rel === "" || rel.startsWith("..")) return null
    dir = dirname(dir)
  }
}

/**
 * The command that renders `absFile` with `tool` at `toolPath`.
 * Quarto: `quarto render <name> --to html --output-dir _render/<name>`, run in
 * the file's folder, writes `_render/<name>/<stem>.html`. Inside a Quarto project
 * (`quartoProjectDir`, see {@link findQuartoProject}) Quarto reads `--output-dir`
 * relative to the project and keeps the file's path inside it, so the HTML is
 * `_render/<name>/<file path in the project>.html`.
 * MyST: mystmd builds HTML only for a project, so PI Lab writes a one-page
 * `_render/<name>/myst.yml` (its table of contents points at the file) and runs
 * `myst build --html --execute --ci` there, which writes
 * `_render/<name>/_build/html/index.html`.
 */
export function renderPlan(
  tool: DocumentTool,
  toolPath: string,
  absFile: string,
  quartoProjectDir: string | null,
): RenderPlan {
  const name = basename(absFile)
  const fileDir = dirname(absFile)
  const outputDir = join(fileDir, RENDER_FOLDER, name)
  if (tool === "quarto") {
    const base = quartoProjectDir ?? fileDir
    const htmlPath = relative(base, absFile).replace(/\.[^./\\]+$/, ".html")
    return {
      command: toolPath,
      args: [
        "render",
        name,
        "--to",
        "html",
        "--output-dir",
        relative(base, outputDir).split(sep).join("/"),
      ],
      cwd: fileDir,
      setupFiles: [],
      outputPath: join(outputDir, htmlPath),
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
 * Add the `_render` folder next to `absFile`, and Quarto's `.quarto` folder (in
 * `quartoDir`, the Quarto project folder or the file's folder), to the repo's
 * `.git/info/exclude` as `/<folder from the repo root>/<name>/`. Does nothing
 * outside a Git repo.
 */
export async function excludeRenderFolder(
  absFile: string,
  quartoDir: string | null,
): Promise<void> {
  const fileDir = dirname(absFile)
  if (!(await isGitRepo(fileDir))) return
  const root = await realpath(await repoRoot(fileDir))
  const folders = [join(await realpath(fileDir), RENDER_FOLDER)]
  if (quartoDir) folders.push(join(await realpath(quartoDir), ".quarto"))
  for (const folder of folders) {
    await addLocalExclude(fileDir, `/${relative(root, folder).split(sep).join("/")}/`)
  }
}

/** The outcome of a render. `log` holds the tool's output, and the reason when it failed. */
export interface RenderOutcome {
  ok: boolean
  log: string
  outputPath: string | null
}

/** Keep only the end of a long log. */
const MAX_LOG = 200_000

/** How long a stopped render may take to exit after SIGTERM before SIGKILL. */
const RENDER_STOP_GRACE_MS = 3_000

/** Renders that run now, so quitting PI Lab can stop them. */
const runningRenders = new Set<ProcessGroup>()

/** Stop every running render and what it started (app quit). */
export async function stopRunningRenders(): Promise<void> {
  await Promise.all([...runningRenders].map((group) => group.stop(RENDER_STOP_GRACE_MS)))
}

/**
 * Run `plan`: write its setup files, remove an old output so a failed run never
 * shows a stale page, run the command without a shell in its own process group,
 * and report the result. After `timeoutMs` the whole group (with any kernels the
 * tool started) is killed. A run is ok only when the command exits 0 and wrote
 * the expected HTML.
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
    const group = new ProcessGroup(plan.command, plan.args, { cwd: plan.cwd, env })
    runningRenders.add(group)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      group.signal("SIGKILL")
    }, timeoutMs)
    group.child.stdout.on("data", append)
    group.child.stderr.on("data", append)
    group.child.on("error", (error) => append(Buffer.from(`\n${error.message}`)))
    // Once the tool exits, the group's watcher ends what it left behind, so "close"
    // (all output read) always follows.
    group.child.on("close", (exitCode, signal) => {
      clearTimeout(timer)
      runningRenders.delete(group)
      const reason = timedOut
        ? `Stopped: the render did not finish within ${Math.round(timeoutMs / 1000)} seconds.`
        : `Stopped by signal ${signal}.`
      resolveRun({ code: exitCode, log: exitCode === null ? `${output}\n${reason}` : output })
    })
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
