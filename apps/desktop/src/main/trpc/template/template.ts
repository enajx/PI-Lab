import { readdir } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { readTextFile, statFile, writeTextFile } from "@pi-lab/workspace-fs"
import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { publicProcedure, router } from "../trpc"
import { resolveWritableTemplateDir, seedWritableTemplate } from "./templateDir"

/**
 * Template router — read/write the files of the *writable* project template
 * (`~/.pi-lab/template`) that backs the Settings "Project template" editor and
 * `projects.createFromTemplate`. The shape mirrors the files router: thin
 * procedures that jail every path to the template dir and delegate I/O to
 * `@pi-lab/workspace-fs`. Every procedure lazily seeds the writable copy first
 * (idempotent — a no-op once it exists) so the surface works on a cold start even
 * if the boot-time seed was skipped.
 */

const relPathInput = z.object({
  /** Path relative to the template directory (one of its immediate files). */
  relPath: z.string().min(1),
})

const writeInput = relPathInput.extend({
  content: z.string(),
})

/** One file in the template listing, addressed by its template-relative name. */
export interface TemplateFileEntry {
  /** The file's own name (e.g. `AGENTS.md`). */
  name: string
  /** Path relative to the template dir — for the flat template, the name itself. */
  relPath: string
  kind: "file"
}

/** A file's contents plus whether it existed (so the editor can show an empty state). */
export interface TemplateReadResult {
  exists: boolean
  content: string
}

/** Names never surfaced in the template listing (editor/VCS cruft). */
const HIDDEN_NAMES = new Set([".DS_Store", ".git"])

/**
 * Resolve `relPath` against the template `dir`, guaranteeing the result stays
 * inside it. Absolute inputs and any `..` escape are rejected with FORBIDDEN —
 * the same path-jailing rule the files router applies to a workspace, kept pure
 * (path math only) so it is unit-testable.
 */
export function resolveInsideTemplate(dir: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Path must be relative to the template: ${relPath}`,
    })
  }

  const base = resolve(dir)
  const target = resolve(base, relPath)
  const rel = relative(base, target)

  const escapes = rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  if (escapes) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Path escapes the template directory: ${relPath}`,
    })
  }

  return target
}

/**
 * The template's immediate files, sorted by name. The `CLAUDE.md` symlink (→
 * `AGENTS.md`) is intentionally listed like any other file: we resolve each
 * entry's type via `statFile` (which follows symlinks), so a symlinked file is
 * surfaced rather than dropped. Directories and cruft are excluded.
 */
async function listTemplateFiles(dir: string): Promise<TemplateFileEntry[]> {
  const names = await readdir(dir)
  const entries: TemplateFileEntry[] = []
  for (const name of names) {
    if (HIDDEN_NAMES.has(name)) continue
    const info = await statFile(join(dir, name))
    if (!info.exists) continue
    entries.push({ name, relPath: name, kind: "file" })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

export const templateRouter = router({
  /** List the writable template's immediate files (the `CLAUDE.md` symlink included). */
  list: publicProcedure.query(async (): Promise<TemplateFileEntry[]> => {
    await seedWritableTemplate()
    return listTemplateFiles(resolveWritableTemplateDir())
  }),

  /**
   * Read one template file. A missing file is a normal answer (`exists: false`,
   * empty content) so the editor can render an empty state; any other I/O failure
   * still surfaces.
   */
  read: publicProcedure
    .input(relPathInput)
    .query(async ({ input }): Promise<TemplateReadResult> => {
      await seedWritableTemplate()
      const target = resolveInsideTemplate(resolveWritableTemplateDir(), input.relPath)
      try {
        return { exists: true, content: await readTextFile(target) }
      } catch (error) {
        if (isNotFound(error)) return { exists: false, content: "" }
        throw error
      }
    }),

  /**
   * Write one template file, returning the byte length written. Writing through
   * the `CLAUDE.md` symlink updates `AGENTS.md` (the link target) — by design.
   */
  write: publicProcedure
    .input(writeInput)
    .mutation(async ({ input }): Promise<{ bytes: number }> => {
      await seedWritableTemplate()
      const target = resolveInsideTemplate(resolveWritableTemplateDir(), input.relPath)
      await writeTextFile(target, input.content)
      return { bytes: Buffer.byteLength(input.content, "utf8") }
    }),
})

/** Whether an error is Node's "no such file or directory". */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}
