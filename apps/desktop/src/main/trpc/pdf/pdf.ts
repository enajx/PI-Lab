import { execFile } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { lstat, mkdir, open, readdir, readFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  getSettingsOrDefaults,
  type PiLabDatabase,
  type ProjectPaper,
  projects,
  workspaces,
} from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { observable } from "@trpc/server/observable"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { GENERATED_EXTENSIONS } from "../../latex/outputDir"
import { type LatexRuntime, resolveLatexRuntime } from "../../latex/runtime"
import { forwardSync, reverseSync } from "../../latex/synctex"
import { effectiveOutputDir, excludePaperOutputs, mainDocOf } from "../../paper/outputs"
import type { AppContext } from "../context"
import { resolveInsideDir } from "../files/files"
import { publicProcedure, router } from "../trpc"
import { workspaceWorkingDir } from "../workspaces/workspaces"

const MAX_PDF_BYTES = 100_000_000
const MAX_TEX_BYTES = 2_000_000
const pathInput = z.object({ workspaceId: z.string().min(1), relPath: z.string().min(1) })
const builds = new Map<string, Promise<BuildResult>>()

/**
 * Live events of the builds in one workspace, sent by the
 * {@link pdfRouter.onBuildOutput} subscription while a build runs:
 *   - `start`: a compile of root `relPath` began. `firstBuild` is true when
 *     bundled Tectonic starts with an empty package cache, so it will download
 *     TeX packages.
 *   - `downloading`: the compiler output shows it is downloading TeX packages.
 *   - `chunk`: compiler output as it is printed.
 *   - `end`: the compile finished; its result comes from the `build` mutation.
 * `buildId` tells apart builds of different roots running at the same time.
 */
export type BuildOutputEvent =
  | { kind: "start"; buildId: number; relPath: string; firstBuild: boolean }
  | { kind: "downloading"; buildId: number }
  | { kind: "chunk"; buildId: number; text: string }
  | { kind: "end"; buildId: number }

/** Build output events, emitted under the workspace id that asked for the build. */
const buildOutput = new EventEmitter()
buildOutput.setMaxListeners(0)
let nextBuildId = 1

/** Tectonic prints "downloading" for each bundle file it fetches. */
const DOWNLOADING_PATTERN = /\bdownloading\b/i

export interface BuildResult {
  relPath: string
  success: boolean
  log: string
}

/** A workspace's real directory and the project it belongs to. */
interface BuildTarget {
  dir: string
  projectId: string
}

/** Where one root .tex builds to, and the paper repo that must not commit that output. */
interface SourceOutput {
  /** Output folder relative to the root .tex file's folder ("." means next to it). */
  outputDir: string
  /**
   * Real path of the linked paper folder holding the root, whose repo gets the
   * output exclude rules; null when the root is not in one, or when Sync is
   * off for the paper (nothing is pushed then).
   */
  paperDir: string | null
}

/**
 * Resolve the workspace once and keep all file access inside its real
 * directory. A paper workspace needs a linked paper.
 */
async function workspaceDirectory(db: PiLabDatabase, workspaceId: string): Promise<BuildTarget> {
  const workspace = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get()
  if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" })
  const dir = await realpath(workspaceWorkingDir(db, workspace))
  if (workspace.kind === "paper" && !projectPaper(db, workspace.projectId)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No paper folder is linked" })
  }
  return { dir, projectId: workspace.projectId }
}

/** The project's linked paper, if any. */
function projectPaper(db: PiLabDatabase, projectId: string): ProjectPaper | undefined {
  return db.select().from(projects).where(eq(projects.id, projectId)).get()?.metadata?.paper
}

/**
 * The output folder of a root .tex: when the root lies inside the project's
 * linked paper folder (whichever workspace builds it, e.g. the Project view for
 * a paper inside the project), the paper's output folder (override, else the
 * global default); otherwise the global default.
 */
async function sourceOutput(
  db: PiLabDatabase,
  target: BuildTarget,
  source: string,
): Promise<SourceOutput> {
  const defaultOutputDir = getSettingsOrDefaults(db).editor.latexOutputDir
  const found = await paperOf(db, target, source)
  if (!found) return { outputDir: defaultOutputDir, paperDir: null }
  const { paper, paperDir } = found
  const outputDir = effectiveOutputDir(paper, defaultOutputDir)
  return { outputDir, paperDir: paper.syncEnabled === false ? null : paperDir }
}

/** Reject lexical traversal and symlinks whose targets leave the workspace. */
export async function insideFile(dir: string, relPath: string): Promise<string> {
  const target = await realpath(resolveInsideDir(dir, relPath))
  resolveInsideDir(dir, relative(dir, target))
  return target
}

/** The bytes of a PDF file and the size and time they were read at. */
export interface PdfSnapshot {
  data: Uint8Array
  baseline: { mtimeMs: number; size: number }
}

/**
 * Read a whole PDF file (at most 100 MB) for the PDF.js viewer. Throws when
 * the path is not a `.pdf`, the file changes while it is read, or it has no PDF
 * header. `path` must already be checked to be inside its folder.
 */
export async function readPdfSnapshot(path: string): Promise<PdfSnapshot> {
  if (extname(path).toLowerCase() !== ".pdf") throw new Error("Select a PDF file")
  const handle = await open(path, "r")
  return (async () => {
    const baseline = await handle.stat()
    if (!baseline.isFile() || baseline.size > MAX_PDF_BYTES)
      throw new Error("PDF exceeds the 100 MB limit")
    const bytes = Buffer.alloc(baseline.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (read.bytesRead === 0)
        throw new Error("PDF changed while being read; waiting for the next refresh")
      offset += read.bytesRead
    }
    const after = await handle.stat()
    if (after.size !== baseline.size || after.mtimeMs !== baseline.mtimeMs)
      throw new Error("PDF changed while being read; waiting for the next refresh")
    if (bytes.subarray(0, 1024).indexOf("%PDF-") < 0)
      throw new Error("This file does not contain a PDF header")
    return {
      data: new Uint8Array(bytes),
      baseline: { mtimeMs: baseline.mtimeMs, size: baseline.size },
    }
  })().finally(() => handle.close())
}

/** Renderer paths always use forward slashes, including on Windows. */
function rendererPath(dir: string, target: string): string {
  return relative(dir, target).split(sep).join("/")
}

/** Read small TeX sources without sending them across IPC. */
async function texSource(path: string): Promise<string> {
  if (extname(path).toLowerCase() !== ".tex") throw new Error("Select a .tex source file")
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_TEX_BYTES) throw new Error("LaTeX source exceeds 2 MB")
  return readFile(path, "utf8")
}

/**
 * The real path of the linked paper folder when `source` lies inside it, with
 * the paper; null otherwise.
 */
async function paperOf(
  db: PiLabDatabase,
  target: BuildTarget,
  source: string,
): Promise<{ paper: ProjectPaper; paperDir: string } | null> {
  const paper = projectPaper(db, target.projectId)
  if (!paper || !existsSync(paper.dir)) return null
  const paperDir = await realpath(paper.dir)
  const path = relative(paperDir, source)
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return null
  return { paper, paperDir }
}

/**
 * The paper's main document for a source inside the linked paper folder:
 * the saved choice when `saved` is true, else the guess ({@link mainDocOf}).
 * Null when the source is outside the paper, there is none, or the saved file
 * no longer exists.
 */
async function paperMainSource(
  db: PiLabDatabase,
  target: BuildTarget,
  source: string,
  saved: boolean,
): Promise<string | null> {
  const found = await paperOf(db, target, source)
  if (!found) return null
  const { paper, paperDir } = found
  const mainDoc = saved ? (paper.mainDoc ?? null) : await mainDocOf(paper, null)
  // A saved main document that was deleted or renamed is passed over, as the footer does.
  if (mainDoc === null || !existsSync(join(paperDir, mainDoc))) return null
  return insideFile(target.dir, relative(target.dir, join(paperDir, mainDoc)))
}

/**
 * Follow explicit root comments, then the source itself. A source with neither
 * builds the linked paper's saved main document when it lies inside the paper,
 * else an ancestor main.tex with `\documentclass`, else the paper's guessed
 * main document.
 */
async function rootSource(
  db: PiLabDatabase,
  target: BuildTarget,
  relPath: string,
): Promise<string> {
  const { dir } = target
  let current = await insideFile(dir, relPath)
  const seen = new Set<string>()
  while (true) {
    if (seen.has(current)) throw new Error("Circular LaTeX root comments")
    seen.add(current)
    const source = await texSource(current)
    const root = /^\s*%\s*!\s*tex\s+root\s*=\s*(.+?)\s*$/im.exec(source)?.[1]
    if (root) {
      current = await insideFile(dir, relative(dir, resolve(dirname(current), root)))
      continue
    }
    if (/^\s*\\documentclass(?:\[|\{)/m.test(source)) return current
    const saved = await paperMainSource(db, target, current, true)
    if (saved !== null) return saved
    let parent = dirname(current)
    while (true) {
      const candidate = join(parent, "main.tex")
      const exists = await stat(candidate).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false
          throw error
        },
      )
      if (exists && candidate !== current) {
        const checked = await insideFile(dir, relative(dir, candidate))
        if (/^\s*\\documentclass(?:\[|\{)/m.test(await texSource(checked))) return checked
      }
      if (parent === dir) break
      const next = dirname(parent)
      if (next === parent || relative(dir, next).startsWith("..")) break
      parent = next
    }
    const guessed = await paperMainSource(db, target, current, false)
    if (guessed !== null && guessed !== current) return guessed
    throw new Error(
      "Cannot find the LaTeX root. Add % !TeX root = path/to/main.tex to this source.",
    )
  }
}

/**
 * Commands use the login shell's PATH but never execute through a shell.
 * `onOutput` receives stdout and stderr text as it is printed.
 */
async function runTool(
  runtime: LatexRuntime,
  args: string[],
  cwd: string,
  timeout: number,
  onOutput: (text: string) => void,
): Promise<{ success: boolean; output: string }> {
  return new Promise((done, reject) => {
    const child = execFile(
      runtime.executable,
      args,
      { cwd, env: runtime.env, timeout, maxBuffer: 2_000_000, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(error)
          return
        }
        done({
          success: !error,
          output: `${stdout}\n${stderr}${error ? `\n${error.message}` : ""}`.slice(-100_000),
        })
      },
    )
    child.stdout?.on("data", (text: string) => onOutput(text))
    child.stderr?.on("data", (text: string) => onOutput(text))
  })
}

/** True when Tectonic's package cache folder is empty, so the build downloads packages. */
async function cacheIsEmpty(runtime: LatexRuntime): Promise<boolean> {
  if (!runtime.cacheDir) return false
  return (await readdir(runtime.cacheDir)).length === 0
}

/**
 * Create the output folder under the root's folder one part at a time, so an
 * existing symlinked part cannot send compiler writes outside the workspace,
 * and check that existing output entries do not point outside it either. For
 * "." only the root's generated files are checked (the folder holds sources).
 * Returns the real output folder.
 */
async function prepareOutput(dir: string, source: string, outputDir: string): Promise<string> {
  let output = await realpath(dirname(source))
  for (const part of outputDir === "." ? [] : outputDir.split("/")) {
    const next = join(output, part)
    const exists = await stat(next).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
    if (!exists) await mkdir(next)
    output = await realpath(next)
    resolveInsideDir(dir, relative(dir, output))
  }
  const name = basename(source, extname(source))
  const entries =
    outputDir === "."
      ? GENERATED_EXTENSIONS.map((extension) => `${name}${extension}`)
      : (await readdir(output, { withFileTypes: true }))
          .filter((entry) => entry.isSymbolicLink())
          .map((entry) => entry.name)
  for (const entry of entries) {
    const path = join(output, entry)
    const isLink = await lstat(path).then(
      (info) => info.isSymbolicLink(),
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
    if (isLink) await insideFile(dir, relative(dir, path))
  }
  return output
}

/**
 * One full compile per root at a time; a later request runs after the earlier
 * one. Live output goes to `workspaceId`'s {@link BuildOutputEvent} listeners.
 */
async function compile(
  ctx: AppContext,
  workspaceId: string,
  target: BuildTarget,
  source: string,
): Promise<BuildResult> {
  const { dir } = target
  const pending = builds.get(source)
  const task = (pending ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const { outputDir, paperDir } = await sourceOutput(ctx.db, target, source)
      const output = await prepareOutput(dir, source, outputDir)
      if (paperDir) await excludePaperOutputs(paperDir, outputDir, rendererPath(paperDir, source))
      const runtime = await resolveLatexRuntime(
        ctx,
        getSettingsOrDefaults(ctx.db).editor.latexProvider,
      )
      const buildId = nextBuildId++
      const send = (event: BuildOutputEvent): void => {
        buildOutput.emit(workspaceId, event)
      }
      send({
        kind: "start",
        buildId,
        relPath: rendererPath(dir, source),
        firstBuild: await cacheIsEmpty(runtime),
      })
      let downloading = false
      const onOutput = (text: string): void => {
        send({ kind: "chunk", buildId, text })
        if (downloading || runtime.provider !== "bundled" || !DOWNLOADING_PATTERN.test(text)) return
        downloading = true
        send({ kind: "downloading", buildId })
      }
      const result = await runTool(
        runtime,
        runtime.provider === "bundled"
          ? ["--synctex", "--untrusted", "--outdir", output, source]
          : [
              "-synctex=1",
              "-interaction=nonstopmode",
              "-file-line-error",
              "-pdf",
              `-outdir=${output}`,
              source,
            ],
        dirname(source),
        runtime.provider === "bundled" ? 300_000 : 120_000,
        onOutput,
      ).finally(() => send({ kind: "end", buildId }))
      return {
        relPath: rendererPath(dir, join(output, `${basename(source, extname(source))}.pdf`)),
        success: result.success,
        log: result.output,
      }
    })
  builds.set(source, task)
  return task.finally(() => {
    if (builds.get(source) === task) builds.delete(source)
  })
}

/** Locate an explicit or standard output and the matching SyncTeX data. */
async function pdfForSource(
  db: PiLabDatabase,
  target: BuildTarget,
  source: string,
  explicit: string | undefined,
): Promise<string> {
  const { dir } = target
  if (explicit) return insideFile(dir, explicit)
  const root = await rootSource(db, target, rendererPath(dir, source))
  const name = `${basename(root, extname(root))}.pdf`
  const { outputDir } = await sourceOutput(db, target, root)
  const candidates = [join(dirname(root), outputDir, name), join(dirname(root), name)]
  for (const path of candidates) {
    const exists = await stat(path).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
    if (exists) return insideFile(dir, relative(dir, path))
  }
  throw new Error("Build this LaTeX document before navigating to its PDF")
}

/** Require SyncTeX files to stay within the workspace, just like the PDF. */
async function requireSyncFile(dir: string, pdf: string): Promise<string> {
  for (const suffix of [".synctex.gz", ".synctex"]) {
    const path = pdf.slice(0, -extname(pdf).length) + suffix
    const exists = await stat(path).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
    if (exists) {
      return insideFile(dir, relative(dir, path))
    }
  }
  throw new Error("No SyncTeX mapping found. Rebuild with SyncTeX enabled (-synctex=1).")
}

export const pdfRouter = router({
  read: publicProcedure.input(pathInput).query(async ({ ctx, input }) => {
    const { dir } = await workspaceDirectory(ctx.db, input.workspaceId)
    const path = await insideFile(dir, input.relPath)
    return readPdfSnapshot(path)
  }),
  build: publicProcedure.input(pathInput).mutation(async ({ ctx, input }): Promise<BuildResult> => {
    const target = await workspaceDirectory(ctx.db, input.workspaceId)
    return compile(ctx, input.workspaceId, target, await rootSource(ctx.db, target, input.relPath))
  }),
  /**
   * Live output of the builds in one workspace; see {@link BuildOutputEvent}.
   * Only builds that start after subscribing are sent; nothing is replayed.
   */
  onBuildOutput: publicProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .subscription(({ input }) =>
      observable<BuildOutputEvent>((emit) => {
        const listener = (event: BuildOutputEvent): void => emit.next(event)
        buildOutput.on(input.workspaceId, listener)
        return () => {
          buildOutput.off(input.workspaceId, listener)
        }
      }),
    ),
  forwardSync: publicProcedure
    .input(
      pathInput.extend({
        line: z.number().int().positive(),
        column: z.number().int().positive(),
        pdfRelPath: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const target = await workspaceDirectory(ctx.db, input.workspaceId)
      const { dir } = target
      const source = await insideFile(dir, input.relPath)
      const pdf = await pdfForSource(ctx.db, target, source, input.pdfRelPath)
      const mapping = await requireSyncFile(dir, pdf)
      const result = await forwardSync(mapping, source, input.line, input.column)
      return { relPath: rendererPath(dir, pdf), ...result }
    }),
  reverseSync: publicProcedure
    .input(
      pathInput.extend({
        page: z.number().int().positive(),
        x: z.number().finite().nonnegative(),
        y: z.number().finite().nonnegative(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { dir } = await workspaceDirectory(ctx.db, input.workspaceId)
      const pdf = await insideFile(dir, input.relPath)
      const mapping = await requireSyncFile(dir, pdf)
      const result = await reverseSync(mapping, input.page, input.x, input.y)
      const source = await insideFile(dir, relative(dir, result.sourceAbsolutePath))
      return {
        relPath: rendererPath(dir, source),
        line: result.line,
        column: result.column,
      }
    }),
})
