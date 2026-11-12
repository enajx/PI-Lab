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
 * `open` loads the diary for the panel: it renames the diary to the current
 * format's extension when only the other one exists, and otherwise writes
 * nothing. The text it returns has today's heading at the top when today has
 * none, and a MyST front matter when the format is MyST and the file has none,
 * so the user can write under today's heading. `save` writes the panel's edit
 * without the day headings that have nothing under them, unless the file
 * changed on disk since it was loaded (same mtime + size check as the editor's
 * save). So the file only has headings for days with an entry.
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
 * heading goes below a leading YAML front matter block (see splitFrontMatter) and
 * a leading `# ` title line, when present. Keeps the file's `\r\n` line endings.
 */
export function withTodayHeading(content: string, heading: string): string {
  if (content.split("\n").some((line) => line.trimEnd() === heading)) return content
  const eol = content.includes("\r\n") ? "\r\n" : "\n"
  const { block, body } = splitFrontMatter(content)
  const lines = body.split(/\r?\n/)
  let index = 0
  while (index < lines.length && lines[index]?.trim() === "") index += 1
  if (lines[index]?.startsWith("# ")) index += 1
  else index = 0
  const head = `${block}${lines.slice(0, index).join(eol)}`.trimEnd()
  const rest = lines
    .slice(index)
    .join(eol)
    .replace(/^\s*\n/, "")
  const top = head.trim() === "" ? "" : `${head}${eol}${eol}`
  return `${top}${heading}${eol}${eol}${rest}`
}

/** A `## YYYY-MM-DD` day heading line (a trailing `\r` or spaces allowed). */
const DAY_HEADING = /^## \d{4}-\d{2}-\d{2}\s*$/

/**
 * Remove each day heading that has nothing under it: only blank lines up to the
 * next `# ` or `## ` heading or the end of the file. The heading goes together
 * with the blank lines after it. A leading YAML front matter is kept as it is.
 */
export function withoutEmptyDayHeadings(content: string): string {
  const { block, body } = splitFrontMatter(content)
  const lines = body.split("\n")
  const kept: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (DAY_HEADING.test(line)) {
      let next = index + 1
      while (next < lines.length && lines[next]?.trim() === "") next += 1
      const following = lines[next]
      if (following === undefined || /^#{1,2} /.test(following)) {
        // At the end of the file, end the text before the heading with one line break.
        if (following === undefined && kept.length > 0) {
          while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") kept.pop()
          kept.push("")
        }
        index = next
        continue
      }
    }
    kept.push(line)
    index += 1
  }
  return `${block}${kept.join("\n")}`
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
  /** Rename to the current format if needed; return the text with today's heading, writing nothing. */
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
      return { ...loaded, content: withTodayHeading(marked, localDateHeading(new Date())) }
    }),

  /**
   * Write the panel's edit without its empty day headings; refuse (CONFLICT) when
   * the file changed since `baseline`.
   */
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
      const content = withoutEmptyDayHeadings(input.content)
      await writeTextFile(target, content)
      const verified = await verifyWrittenText(target, content)
      if (!verified.matchesWrittenContent) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `${input.relPath} changed on disk while saving. Close and reopen the diary to check it.`,
        })
      }
      return { baseline: verified.baseline }
    }),
})
