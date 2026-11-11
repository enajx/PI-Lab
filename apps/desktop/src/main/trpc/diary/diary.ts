import { rename } from "node:fs/promises"
import { join } from "node:path"
import { getSettingsOrDefaults, type PiLabDatabase, projects } from "@pi-lab/local-db"
import type { ResearchDiaryFormat } from "@pi-lab/local-db/editor-settings"
import { splitFrontMatter } from "@pi-lab/shared/markdown/front-matter"
import {
  type FileStat,
  readTextSnapshot,
  statFile,
  verifyWrittenText,
  writeTextFile,
} from "@pi-lab/workspace-fs"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { publicProcedure, router } from "../trpc"

/**
 * Research diary router: a blog-style Markdown log at
 * `<project folder>/md/research-diary/diary.md` (or `diary.qmd` with the Quarto
 * format setting; MyST also uses `diary.md`), one `## YYYY-MM-DD` heading per
 * day, newest first.
 *
 * `open` prepares the file for the diary panel: it renames the diary to the
 * current format's extension when only the other one exists, creates it when
 * missing, adds a MyST front matter when the format is MyST and the file has
 * none, and adds today's heading at the top when today has none. `save` writes the panel's
 * edit unless the file changed on disk since it was loaded (same mtime + size
 * check as the editor's save).
 */

const DIARY_DIR = "md/research-diary"

/** The diary's file extension: MyST is Markdown with a front matter, so it uses `.md`. */
type DiaryExtension = "md" | "qmd"

function diaryExtension(format: ResearchDiaryFormat): DiaryExtension {
  return format === "qmd" ? "qmd" : "md"
}

/** The diary's path relative to the project folder for a file extension. */
function diaryRelPath(extension: DiaryExtension): string {
  return `${DIARY_DIR}/diary.${extension}`
}

/**
 * The front matter added to a MyST diary that has none. `title` is a standard
 * mystmd page front matter field; the leading block marks the file as MyST.
 */
export const MYST_DIARY_FRONT_MATTER = "---\ntitle: Research diary\n---\n"

/** Put {@link MYST_DIARY_FRONT_MATTER} at the top of `content` unless it has a front matter. */
export function withMystFrontMatter(content: string): string {
  if (splitFrontMatter(content).frontMatter !== null) return content
  return `${MYST_DIARY_FRONT_MATTER}\n${content}`
}

/** `## YYYY-MM-DD` for the local calendar date of `date`. */
export function localDateHeading(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `## ${date.getFullYear()}-${month}-${day}`
}

/**
 * Put `heading` at the top of `content` unless a line already equals it. The
 * heading goes below a leading YAML front matter block and a leading `# ` title
 * line, when present.
 */
export function withTodayHeading(content: string, heading: string): string {
  const lines = content.split("\n")
  if (lines.some((line) => line.trimEnd() === heading)) return content
  let index = 0
  while (index < lines.length && lines[index]?.trim() === "") index += 1
  if (lines[index] === "---") {
    const close = lines.findIndex((line, at) => at > index && line === "---")
    if (close !== -1) index = close + 1
    while (index < lines.length && lines[index]?.trim() === "") index += 1
  }
  if (lines[index]?.startsWith("# ")) index += 1
  const head = lines.slice(0, index).join("\n").trimEnd()
  const rest = lines
    .slice(index)
    .join("\n")
    .replace(/^\s*\n/, "")
  const top = head === "" ? "" : `${head}\n\n`
  return `${top}${heading}\n\n${rest}`
}

/** The project's folder, or a clean NOT_FOUND. */
function projectFolder(db: PiLabDatabase, projectId: string): string {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: `No project ${projectId}` })
  return project.repoPath
}

/** The diary as loaded by the panel. `baseline` is the file's mtime + size when read. */
export interface DiaryFile {
  relPath: string
  content: string
  baseline: FileStat
}

/** Read the diary text, failing loudly on a file the panel cannot show. */
async function readDiary(absPath: string, relPath: string): Promise<DiaryFile> {
  const snapshot = await readTextSnapshot(absPath)
  if (snapshot.status === "oversized" || snapshot.status === "binary") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${relPath} is not a readable text file (${snapshot.status}).`,
    })
  }
  return { relPath, content: snapshot.content, baseline: snapshot.baseline }
}

const fileStat = z.object({
  exists: z.boolean(),
  mtimeMs: z.number(),
  size: z.number(),
})

export const diaryRouter = router({
  /** Rename to the current format if needed, then ensure the file and today's heading exist. */
  open: publicProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<DiaryFile> => {
      const folder = projectFolder(ctx.db, input.projectId)
      const format = getSettingsOrDefaults(ctx.db).editor.researchDiaryFormat
      const extension = diaryExtension(format)
      const relPath = diaryRelPath(extension)
      const target = join(folder, relPath)
      const other = join(folder, diaryRelPath(extension === "md" ? "qmd" : "md"))
      if (!(await statFile(target)).exists && (await statFile(other)).exists) {
        await rename(other, target)
      }
      const loaded = await readDiary(target, relPath)
      const marked = format === "myst" ? withMystFrontMatter(loaded.content) : loaded.content
      const next = withTodayHeading(marked, localDateHeading(new Date()))
      if (next === loaded.content && loaded.baseline.exists) return loaded
      await writeTextFile(target, next)
      return readDiary(target, relPath)
    }),

  /** Write the panel's edit; refuse (CONFLICT) when the file changed since `baseline`. */
  save: publicProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        relPath: z.enum([diaryRelPath("md"), diaryRelPath("qmd")]),
        content: z.string(),
        baseline: fileStat,
      }),
    )
    .mutation(async ({ ctx, input }): Promise<{ baseline: FileStat }> => {
      const target = join(projectFolder(ctx.db, input.projectId), input.relPath)
      const current = await statFile(target)
      if (
        current.exists !== input.baseline.exists ||
        current.mtimeMs !== input.baseline.mtimeMs ||
        current.size !== input.baseline.size
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `${input.relPath} changed on disk since it was loaded. Your edit was not saved. Copy it, then close and reopen the diary to load the new version.`,
        })
      }
      await writeTextFile(target, input.content)
      const verified = await verifyWrittenText(target, input.content)
      if (!verified.matchesWrittenContent) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `${input.relPath} changed on disk while saving. Close and reopen the diary to check it.`,
        })
      }
      return { baseline: verified.baseline }
    }),
})
