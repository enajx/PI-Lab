import { type PiLabDatabase, type Project, projects } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { and, eq, isNull } from "drizzle-orm"
import { z } from "zod"
import { publicProcedure, router } from "../../trpc"
import { createTask, deleteTask, listProjectTasks, moveTask, updateTask } from "./store"

const taskStatus = z.enum(["backlog", "planned", "wip", "done"])
const tagValue = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^\s#]+$/)
const nullableTag = tagValue.nullable()
const taskFields = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .regex(/^[^\r\n]+$/),
  details: z.string().max(100_000),
  status: taskStatus,
  priority: nullableTag,
  labels: z.array(tagValue).max(100),
  owner: nullableTag,
})
const selector = z.union([
  z.object({ id: z.string().min(1) }).strict(),
  z.object({ key: z.string().min(1) }).strict(),
  z.object({ sourceStart: z.number().int().nonnegative() }).strict(),
])
const mutationFile = z.object({
  projectId: z.string().min(1),
  relPath: z.string().min(1),
  expectedRevision: z.string().min(1),
})

function requireProject(db: PiLabDatabase, projectId: string): Project {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: `No project ${projectId}` })
  return project
}

/**
 * Markdown-backed task procedures. TODO Markdown remains the sole source of
 * truth; the local database remembers each project's selected Markdown file.
 */
export const tasksRouter = router({
  /** Aggregate tasks and source health from every local project. */
  list: publicProcedure.query(async ({ ctx }) => {
    const projectRows = ctx.db.select().from(projects).all()
    const listing = await listProjectTasks(projectRows)
    for (const source of listing.sources) {
      const project = projectRows.find((row) => row.id === source.projectId)
      if (project && !project.taskRelPath && source.state === "ready" && source.relPath) {
        ctx.db
          .update(projects)
          .set({ taskRelPath: source.relPath, updatedAt: Date.now() })
          .where(and(eq(projects.id, project.id), isNull(projects.taskRelPath)))
          .run()
      }
    }
    return listing
  }),

  create: publicProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        relPath: z.string().min(1),
        expectedRevision: z.string().min(1).nullable(),
        headingKey: z.string().min(1).optional(),
        ...taskFields.shape,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = requireProject(ctx.db, input.projectId)
      return createTask({
        project,
        relPath: input.relPath,
        expectedRevision: input.expectedRevision,
        headingKey: input.headingKey,
        fields: pickFields(input),
      })
    }),

  update: publicProcedure
    .input(
      mutationFile.extend({
        selector,
        title: taskFields.shape.title.optional(),
        details: taskFields.shape.details.optional(),
        status: taskStatus.optional(),
        priority: nullableTag.optional(),
        labels: taskFields.shape.labels.optional(),
        owner: nullableTag.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = requireProject(ctx.db, input.projectId)
      const patch = {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.details === undefined ? {} : { details: input.details }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        ...(input.owner === undefined ? {} : { owner: input.owner }),
      }
      return updateTask({
        project,
        relPath: input.relPath,
        expectedRevision: input.expectedRevision,
        selector: input.selector,
        patch,
      })
    }),

  delete: publicProcedure
    .input(mutationFile.extend({ selector }))
    .mutation(async ({ ctx, input }) => {
      const project = requireProject(ctx.db, input.projectId)
      return deleteTask({
        project,
        relPath: input.relPath,
        expectedRevision: input.expectedRevision,
        selector: input.selector,
      })
    }),

  move: publicProcedure
    .input(
      mutationFile.extend({
        selector,
        destination: z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("status"), status: taskStatus }),
          z.object({ mode: z.literal("heading"), headingKey: z.string().min(1) }),
        ]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = requireProject(ctx.db, input.projectId)
      return moveTask({
        project,
        relPath: input.relPath,
        expectedRevision: input.expectedRevision,
        selector: input.selector,
        destination: input.destination,
      })
    }),
})

function pickFields(input: z.infer<typeof taskFields>): z.infer<typeof taskFields> {
  return {
    title: input.title,
    details: input.details,
    status: input.status,
    priority: input.priority,
    labels: input.labels,
    owner: input.owner,
  }
}
