import { execFile } from "node:child_process"
import { mkdir, open, readdir, readFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path"
import { getSettingsOrDefaults, type PiLabDatabase, workspaces } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { type LatexRuntime, resolveLatexRuntime } from "../../latex/runtime"
import { forwardSync, reverseSync } from "../../latex/synctex"
import type { AppContext } from "../context"
import { resolveInsideDir } from "../files/files"
import { publicProcedure, router } from "../trpc"
import { workspaceWorkingDir } from "../workspaces/workspaces"

const MAX_PDF_BYTES = 100_000_000
const MAX_TEX_BYTES = 2_000_000
const pathInput = z.object({ workspaceId: z.string().min(1), relPath: z.string().min(1) })
const builds = new Map<string, Promise<BuildResult>>()

export interface BuildResult {
  relPath: string
  success: boolean
  log: string
}

/** Resolve the workspace once and keep all file access inside its real directory. */
async function workspaceDirectory(db: PiLabDatabase, workspaceId: string): Promise<string> {
  const workspace = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get()
  if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" })
  return realpath(workspaceWorkingDir(db, workspace))
}

/** Reject lexical traversal and symlinks whose targets leave the workspace. */
async function insideFile(dir: string, relPath: string): Promise<string> {
  const target = await realpath(resolveInsideDir(dir, relPath))
  resolveInsideDir(dir, relative(dir, target))
  return target
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

/** Follow explicit root comments, then the source itself or an ancestor main.tex. */
async function rootSource(dir: string, relPath: string): Promise<string> {
  let target = await insideFile(dir, relPath)
  const seen = new Set<string>()
  while (true) {
    if (seen.has(target)) throw new Error("Circular LaTeX root comments")
    seen.add(target)
    const source = await texSource(target)
    const root = /^\s*%\s*!\s*tex\s+root\s*=\s*(.+?)\s*$/im.exec(source)?.[1]
    if (root) {
      target = await insideFile(dir, relative(dir, resolve(dirname(target), root)))
      continue
    }
    if (/^\s*\\documentclass(?:\[|\{)/m.test(source)) return target
    let parent = dirname(target)
    while (true) {
      const candidate = join(parent, "main.tex")
      const exists = await stat(candidate).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false
          throw error
        },
      )
      if (exists && candidate !== target) {
        const checked = await insideFile(dir, relative(dir, candidate))
        if (/^\s*\\documentclass(?:\[|\{)/m.test(await texSource(checked))) return checked
      }
      if (parent === dir) break
      const next = dirname(parent)
      if (next === parent || relative(dir, next).startsWith("..")) break
      parent = next
    }
    throw new Error(
      "Cannot find the LaTeX root. Add % !TeX root = path/to/main.tex to this source.",
    )
  }
}

/** Commands use the login shell's PATH but never execute through a shell. */
async function runTool(
  runtime: LatexRuntime,
  args: string[],
  cwd: string,
  timeout: number,
): Promise<{ success: boolean; output: string }> {
  return new Promise((done, reject) => {
    execFile(
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
  })
}

/** Ensure existing output entries cannot redirect compiler writes outside the workspace. */
async function prepareOutput(dir: string, output: string): Promise<void> {
  const parent = await realpath(dirname(output))
  if (parent !== dir) resolveInsideDir(dir, relative(dir, parent))
  await mkdir(output, { recursive: true })
  const checked = await realpath(output)
  resolveInsideDir(dir, relative(dir, checked))
  for (const entry of await readdir(checked, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) await insideFile(dir, relative(dir, join(checked, entry.name)))
  }
}

/** One full compile per root at a time; a later request runs after the earlier one. */
async function compile(ctx: AppContext, dir: string, source: string): Promise<BuildResult> {
  const pending = builds.get(source)
  const task = (pending ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const output = join(dirname(source), "build")
      await prepareOutput(dir, output)
      const runtime = await resolveLatexRuntime(
        ctx,
        getSettingsOrDefaults(ctx.db).editor.latexProvider,
      )
      const result = await runTool(
        runtime,
        runtime.provider === "bundled"
          ? ["--synctex", "--untrusted", "--outdir", output, source]
          : [
              "-synctex=1",
              "-interaction=nonstopmode",
              "-file-line-error",
              "-pdf",
              "-outdir=build",
              source,
            ],
        dirname(source),
        runtime.provider === "bundled" ? 300_000 : 120_000,
      )
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
  dir: string,
  source: string,
  explicit: string | undefined,
): Promise<string> {
  if (explicit) return insideFile(dir, explicit)
  const root = await rootSource(dir, rendererPath(dir, source))
  const name = `${basename(root, extname(root))}.pdf`
  const candidates = [join(dirname(root), "build", name), join(dirname(root), name)]
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
    const dir = await workspaceDirectory(ctx.db, input.workspaceId)
    const path = await insideFile(dir, input.relPath)
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
  }),
  build: publicProcedure.input(pathInput).mutation(async ({ ctx, input }): Promise<BuildResult> => {
    const dir = await workspaceDirectory(ctx.db, input.workspaceId)
    return compile(ctx, dir, await rootSource(dir, input.relPath))
  }),
  forwardSync: publicProcedure
    .input(
      pathInput.extend({
        line: z.number().int().positive(),
        column: z.number().int().positive(),
        pdfRelPath: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const dir = await workspaceDirectory(ctx.db, input.workspaceId)
      const source = await insideFile(dir, input.relPath)
      const pdf = await pdfForSource(dir, source, input.pdfRelPath)
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
      const dir = await workspaceDirectory(ctx.db, input.workspaceId)
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
