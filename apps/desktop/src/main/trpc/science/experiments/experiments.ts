import { readFile } from "node:fs/promises"
import { projects } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { resolveInsideDir } from "../../files/files"
import { publicProcedure, router } from "../../trpc"

/** Experiment run counts read from a project's experiments file. */
export type ExperimentRunStatus =
  | { found: false; relPath: string }
  | {
      found: true
      relPath: string
      running: number
      finished: number
      failed: number
      /** Every other status word (e.g. PLANNED, ABORTED) with its count, sorted by word. */
      other: { status: string; count: number }[]
    }

/**
 * Where experiment runs are tracked. One kind for now: a Markdown file with a
 * table that has a `status` column (the EXPERIMENTS.md the research skills write).
 */
const sourceSchema = z.object({ kind: z.literal("experiments-md"), relPath: z.string().min(1) })

/** Status words the research skills write, mapped to the three counted groups. */
const STATUS_GROUPS: Record<string, "running" | "finished" | "failed"> = {
  RUNNING: "running",
  COMPLETED: "finished",
  FAILED: "failed",
}

/** Split one Markdown table row into trimmed cells. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
}

/**
 * Count the status cells of every Markdown table whose header has a `status`
 * column. The status word is the cell's first word ("FAILED: node down" is
 * FAILED), compared without case. RUNNING, COMPLETED and FAILED are counted as
 * running, finished and failed; any other word, or an empty cell ("(empty)"), is
 * kept in `other` so no row is dropped. Plain code, no LLM.
 */
export function countExperimentStatuses(
  markdown: string,
): Omit<Extract<ExperimentRunStatus, { found: true }>, "found" | "relPath"> {
  const counts = { running: 0, finished: 0, failed: 0 }
  const other = new Map<string, number>()
  let statusColumn: number | null = null
  let inTable = false
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) {
      inTable = false
      statusColumn = null
      continue
    }
    const cells = tableCells(line)
    if (!inTable) {
      inTable = true
      const index = cells.findIndex((cell) => cell.toLowerCase() === "status")
      statusColumn = index >= 0 ? index : null
      continue
    }
    if (statusColumn === null) continue
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue
    const word = (cells[statusColumn] ?? "").split(/[\s:(]/)[0]?.toUpperCase() ?? ""
    const status = word === "" ? "(empty)" : word
    const group = STATUS_GROUPS[status]
    if (group) counts[group] += 1
    else other.set(status, (other.get(status) ?? 0) + 1)
  }
  return {
    ...counts,
    other: [...other.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => a.status.localeCompare(b.status)),
  }
}

export const experimentsRouter = router({
  /**
   * Experiment run counts for the Project status card, read from the configured
   * source file inside the project. A missing file is `found: false` (shown as
   * "No EXPERIMENTS.md"), never zero runs; other read errors surface.
   */
  status: publicProcedure
    .input(z.object({ projectId: z.string().min(1), source: sourceSchema }))
    .query(async ({ ctx, input }): Promise<ExperimentRunStatus> => {
      const project = ctx.db.select().from(projects).where(eq(projects.id, input.projectId)).get()
      if (!project) {
        throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.projectId}` })
      }
      const path = resolveInsideDir(project.repoPath, input.source.relPath)
      const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      })
      if (content === null) return { found: false, relPath: input.source.relPath }
      return { found: true, relPath: input.source.relPath, ...countExperimentStatuses(content) }
    }),
})
