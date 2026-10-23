import type { Stats } from "node:fs"
import { constants } from "node:fs"
import { copyFile, cp, mkdir, open, readdir, readFile, realpath, stat } from "node:fs/promises"
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  agentSessions,
  automationRuns,
  automations,
  getAgentSettingsOrDefaults,
  getSettingsOrDefaults,
  type Project,
  type ProjectDetails,
  type ProjectMetadata,
  projects,
} from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import { writeProjectAgentConfig } from "../../agents/projectConfig"
import { GitError, isGitRepo, resolveDefaultBranch, runGit } from "../../git"
import { hasPendingAgentLaunch } from "../agentLaunchGuard"
import type { AppContext } from "../context"
import { discoverTaskFile } from "../science/tasks/store"
import {
  resolveInsideTemplate,
  resolveWritableTemplateDir,
  seedWritableTemplate,
} from "../template"
import { publicProcedure, router } from "../trpc"
import { hasRunningProjectWorkflow } from "../workflows/workflows"
import { planningProcedures } from "./planning"
import { readStoredThumbnail, validateThumbnail } from "./thumbnailImage"

/**
 * Projects router — a PI Lab "project" is a local folder opened as a research
 * unit, with Git capabilities when that folder is a repository. The router is thin: each procedure validates
 * input, calls the git layer and the injected Drizzle handle, and returns rows.
 * No orchestration, no cloud — just the local store.
 */

const textTagInput = z.object({
  label: z.string().trim().min(1).max(80),
  color: z.enum(["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"]),
})
const projectDetailsInput = z.object({
  name: z.string().trim().min(1).max(200),
  typeId: z.enum(["general", "research", "software", "manuscript"]),
  deadline: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  agentId: z.string().min(1).nullable(),
  emojiTags: z.array(z.string().min(1)).max(50).optional(),
  textTags: z.array(textTagInput).max(50).optional(),
})

function detailsValues(project: Pick<Project, "metadata"> | undefined, details: ProjectDetails) {
  const metadata = { ...project?.metadata }
  if (details.deadline === null) delete metadata.deadline
  else metadata.deadline = details.deadline
  if (details.emojiTags !== undefined) metadata.emojiTags = details.emojiTags
  if (details.textTags !== undefined) metadata.textTags = details.textTags
  return { name: details.name, typeId: details.typeId, metadata }
}

async function saveDetailsAgent(
  ctx: AppContext,
  project: Pick<Project, "id" | "repoPath" | "agentConfig">,
  details: ProjectDetails,
) {
  if (details.agentId !== null && !ctx.agentCatalog.some((agent) => agent.id === details.agentId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown agent" })
  }
  const storage = getAgentSettingsOrDefaults(ctx.db).projectConfigStorage
  const agentConfig = { ...project.agentConfig, agentId: details.agentId }
  if (storage !== "app") await writeProjectAgentConfig(ctx.db, project, "project", agentConfig)
  return storage === "project" ? {} : { agentConfig }
}

const openInput = z.object({
  /** Absolute path to a Git working tree or ordinary local folder. */
  path: z.string().min(1),
  details: projectDetailsInput.optional(),
})

const idInput = z.object({ id: z.string().min(1) })

const setArchivedInput = z.object({
  id: z.string().min(1),
  archived: z.boolean(),
})

const setThumbnailInput = z.object({
  id: z.string().min(1),
  /**
   * A `data:` image URL to use as the card's header image, or `null` to clear it
   * (reverting the card to its seeded gradient). Only `data:` URLs are accepted —
   * the renderer reads the dropped file into one, so the row stays self-contained
   * (no external paths to dangle).
   */
  dataUrl: z.string().startsWith("data:").max(1_400_000).nullable(),
})

const thumbnailInput = idInput.extend({ variant: z.enum(["card", "badge"]) })

export type ProjectSummary = Omit<Project, "thumbnail"> & { hasThumbnail: boolean }

const setGradientInput = z.object({
  id: z.string().min(1),
  /**
   * The gradient to persist (`{ seed, palette }`, captured from the app theme by
   * the renderer), or `null` to clear it. Setting a non-null gradient also clears
   * any thumbnail — the card shows one artwork at a time, and generating a gradient
   * replaces an imported image.
   */
  gradient: z
    .object({ seed: z.number().int(), palette: z.array(z.string().min(1)).min(1) })
    .nullable(),
})

const setDigitalRainInput = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
})

const DIGITAL_RAIN_TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".r",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
  ".zsh",
])
const DIGITAL_RAIN_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
])
const DIGITAL_RAIN_MAX_CANDIDATES = 240
const DIGITAL_RAIN_MAX_FILE_BYTES = 48 * 1024
const DIGITAL_RAIN_FILES_PER_SAMPLE = 3
const DIGITAL_RAIN_FALLBACK_CHARACTERS = "01<>[]{}()#$%*+=-:;/."
const digitalRainCharactersByProjectId = new Map<string, string>()

/**
 * Extra project metadata edited via the card's "Edit project…" dialog. Every field
 * is optional and only the filled ones are stored; a `null` metadata clears the
 * whole group. Kept in step with {@link ProjectMetadata} in `@pi-lab/local-db`.
 */
const setMetadataInput = z.object({
  id: z.string().min(1),
  metadata: z
    .object({
      collaborators: z.string().min(1).optional(),
      venue: z.string().min(1).optional(),
      deadline: z.string().min(1).optional(),
      emojiTags: z.array(z.string().min(1)).optional(),
      textTags: z.array(textTagInput).optional(),
      referenceLinks: z
        .array(z.object({ url: z.string().min(1), label: z.string().min(1).optional() }))
        .optional(),
    })
    .nullable(),
})

const setDocumentPathInput = z.object({
  id: z.string().min(1),
  kind: z.enum(["tasks", "main"]),
  relPath: z.string().min(1).nullable(),
})

/** Validate a selected Markdown file and retain a relative, portable path. */
async function selectedMarkdownPath(repoPath: string, relPath: string): Promise<string> {
  if (extname(relPath).toLowerCase() !== ".md") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Select a project Markdown file" })
  }
  const root = await realpath(repoPath)
  const candidate = resolve(root, relPath)
  const storedPath = relative(root, candidate)
  if (
    storedPath === "" ||
    storedPath === ".." ||
    storedPath.startsWith(`..${sep}`) ||
    isAbsolute(storedPath)
  ) {
    throw new TRPCError({ code: "FORBIDDEN", message: "File is outside this project" })
  }
  const file = await statOrNull(candidate)
  if (!file?.isFile()) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Markdown file not found: ${relPath}` })
  }
  const realCandidate = await realpath(candidate)
  const realRelative = relative(root, realCandidate)
  if (
    realRelative === "" ||
    realRelative === ".." ||
    realRelative.startsWith(`..${sep}`) ||
    isAbsolute(realRelative)
  ) {
    throw new TRPCError({ code: "FORBIDDEN", message: "File is outside this project" })
  }
  return storedPath.split(sep).join("/")
}

const cloneInput = z.object({
  /** A git remote — http(s)/ssh/scp-style URL or a local path; git is the arbiter. */
  url: z.string().min(1),
  /** Absolute directory the clone will land *inside* (the repo gets its own subdir). */
  parentDir: z.string().min(1),
  details: projectDetailsInput.optional(),
})

const createFromTemplateInput = z.object({
  /** Absolute directory to create as the new project; the template copies into it. */
  targetDir: z.string().min(1),
  details: projectDetailsInput.optional(),
  /**
   * Template folder to copy from. Defaults to the user's writable template under
   * the data dir ({@link resolveWritableTemplateDir}); explicit callers/tests may
   * name any source directory.
   */
  templateDir: z.string().optional(),
  /** Specific template files, addressed relative to `templateDir`. */
  templateFiles: z.array(z.string().min(1)).optional(),
  /** Absolute files picked for this project only. */
  externalFiles: z.array(z.string().min(1)).optional(),
})

/**
 * Register the canonical selected folder, even when it sits inside a larger Git repo.
 * Reopening an existing folder preserves its edited project details.
 */
async function upsertProjectFromDirectory(
  ctx: AppContext,
  dir: string,
  detectExistingType: boolean,
  details: ProjectDetails | undefined,
): Promise<Project> {
  const db = ctx.db
  const requested = resolve(dir)
  const directory = await statOrNull(requested)
  if (!directory?.isDirectory()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Not a directory: ${requested}` })
  }

  const git = await isGitRepo(requested)
  const root = await realpath(requested)
  const name = basename(root) || root
  const defaultBranch = git ? await resolveDefaultBranch(root) : null
  const taskFile = await discoverTaskFile(root)
  const discoveredTaskPath = taskFile.state === "ready" ? taskFile.relPath : null
  const detectedType = detectExistingType && !details ? await detectProjectType(root) : null
  const now = Date.now()

  const existing = db.select().from(projects).where(eq(projects.repoPath, root)).get()
  if (existing) {
    const explicitType =
      existing.typeId === "general" ||
      existing.typeId === "research" ||
      existing.typeId === "software" ||
      existing.typeId === "manuscript"
        ? existing.typeId
        : null
    return db
      .update(projects)
      .set({
        name: existing.name,
        defaultBranch,
        taskRelPath: existing.taskRelPath ?? discoveredTaskPath,
        typeId: explicitType ?? detectedType ?? "general",
        updatedAt: now,
        lastOpenedAt: now,
      })
      .where(eq(projects.id, existing.id))
      .returning()
      .get()
  }

  const agentValues = details
    ? await saveDetailsAgent(ctx, { id: "", repoPath: root, agentConfig: null }, details)
    : {}
  const editedValues = details ? detailsValues(undefined, details) : {}
  return db
    .insert(projects)
    .values({
      repoPath: root,
      name,
      defaultBranch,
      taskRelPath: discoveredTaskPath,
      typeId: detectedType ?? "general",
      ...editedValues,
      ...agentValues,
    })
    .returning()
    .get()
}

/** Infer a type only when exactly one regular root marker is present. */
async function detectProjectType(
  root: string,
): Promise<"research" | "software" | "manuscript" | null> {
  const entries = await readdir(root, { withFileTypes: true })
  const markers = [
    { file: "RESEARCH.md", type: "research" },
    { file: "PROJECT.md", type: "software" },
    { file: "PAPER.md", type: "manuscript" },
    { file: "MANUSCRIPT.md", type: "manuscript" },
  ] as const
  const found = markers.filter((marker) =>
    entries.some((entry) => entry.name === marker.file && entry.isFile()),
  )
  return found.length === 1 ? (found[0]?.type ?? null) : null
}

/**
 * The folder name to create for a cloned remote: the URL's last path segment with
 * any trailing `.git` and slashes stripped (e.g. `git@host:org/repo.git` ⇒ `repo`,
 * `https://host/org/repo/` ⇒ `repo`). Falls back to `"repo"` if nothing is left,
 * so a degenerate URL still yields a usable dir (git then rejects a bad remote).
 */
function repoDirNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  const lastSegment = trimmed.split(/[/:]/).pop() ?? ""
  const name = lastSegment.replace(/\.git$/i, "").trim()
  return name || "repo"
}

/** Whether `dir` already exists on disk (any node — file or directory). */
async function pathExists(dir: string): Promise<boolean> {
  try {
    await stat(dir)
    return true
  } catch {
    return false
  }
}

/** `stat` for `dir`, or `null` when it doesn't exist — to branch on type/emptiness. */
async function statOrNull(dir: string): Promise<Stats | null> {
  try {
    return await stat(dir)
  } catch {
    return null
  }
}

/** Collect a deliberately small, text-only candidate set without entering build or VCS output. */
async function findDigitalRainCandidates(repoPath: string): Promise<string[]> {
  const candidates: string[] = []
  const directories = [repoPath]

  while (directories.length > 0 && candidates.length < DIGITAL_RAIN_MAX_CANDIDATES) {
    const directory = directories.pop()
    if (!directory) continue
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!DIGITAL_RAIN_IGNORED_DIRECTORIES.has(entry.name)) directories.push(path)
        continue
      }
      if (entry.isFile() && DIGITAL_RAIN_TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        candidates.push(path)
      }
      if (candidates.length >= DIGITAL_RAIN_MAX_CANDIDATES) break
    }
  }

  return candidates
}

/** Choose distinct source files with no sorting or full-project scan. */
function chooseDigitalRainFiles(paths: string[]): string[] {
  const choices = [...paths]
  const count = Math.min(DIGITAL_RAIN_FILES_PER_SAMPLE, choices.length)
  for (let index = 0; index < count; index += 1) {
    const picked = index + Math.floor(Math.random() * (choices.length - index))
    ;[choices[index], choices[picked]] = [choices[picked] as string, choices[index] as string]
  }
  return choices.slice(0, count)
}

/** Keep only printable ASCII so every glyph is legible in the compact canvas. */
function toDigitalRainCharacters(text: string): string {
  let characters = ""
  for (const character of text) {
    const code = character.charCodeAt(0)
    if (code >= 33 && code <= 126) characters += character
    if (characters.length >= DIGITAL_RAIN_MAX_FILE_BYTES) break
  }
  return characters
}

/**
 * Sample small, bounded text fragments from this project for its current app
 * session. The result is never persisted: the next PI Lab launch samples anew.
 */
async function sampleDigitalRainCharacters(repoPath: string): Promise<string> {
  const candidates = await findDigitalRainCandidates(repoPath)
  let characters = ""
  for (const path of chooseDigitalRainFiles(candidates)) {
    const details = await stat(path)
    if (details.size > DIGITAL_RAIN_MAX_FILE_BYTES) continue
    characters += toDigitalRainCharacters(await readFile(path, "utf8"))
  }
  return characters || DIGITAL_RAIN_FALLBACK_CHARACTERS
}

export const projectsRouter = router({
  ...planningProcedures,
  /**
   * Open a Git repository or ordinary local folder as a project.
   */
  open: publicProcedure.input(openInput).mutation(({ ctx, input }): Promise<Project> => {
    return upsertProjectFromDirectory(ctx, resolve(input.path), true, input.details)
  }),

  /** Report Git capability from the live filesystem rather than stale database state. */
  capabilities: publicProcedure
    .input(idInput)
    .query(async ({ ctx, input }): Promise<{ git: boolean }> => {
      const project = ctx.db.select().from(projects).where(eq(projects.id, input.id)).get()
      if (!project) {
        throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
      }
      return { git: await isGitRepo(project.repoPath) }
    }),

  /** Bounded, fresh-per-launch source characters for a project's Digital Rain card artwork. */
  digitalRainCharacters: publicProcedure
    .input(idInput)
    .query(async ({ ctx, input }): Promise<{ characters: string }> => {
      const project = ctx.db.select().from(projects).where(eq(projects.id, input.id)).get()
      if (!project) {
        throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
      }
      const existing = digitalRainCharactersByProjectId.get(project.id)
      if (existing) return { characters: existing }
      const characters = await sampleDigitalRainCharacters(project.repoPath)
      digitalRainCharactersByProjectId.set(project.id, characters)
      return { characters }
    }),

  /** Explicitly turn a plain-folder project into a Git repository in place. */
  initializeGit: publicProcedure
    .input(idInput)
    .mutation(async ({ ctx, input }): Promise<Project> => {
      const project = ctx.db.select().from(projects).where(eq(projects.id, input.id)).get()
      if (!project) {
        throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
      }
      try {
        if (!(await isGitRepo(project.repoPath))) {
          await runGit(project.repoPath, ["init", "-b", "main"])
        }
        const head = await runGit(project.repoPath, ["rev-parse", "--verify", "HEAD"], {
          allowFailure: true,
        })
        if (!head.stdout.trim()) {
          await runGit(project.repoPath, [
            "-c",
            "user.name=PI Lab",
            "-c",
            "user.email=pi-lab@localhost",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "--allow-empty",
            "--no-verify",
            "-m",
            "Initialize Git",
          ])
        }
      } catch (error) {
        if (error instanceof GitError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error })
        }
        throw error
      }
      const defaultBranch = (await resolveDefaultBranch(project.repoPath)) ?? "main"
      return ctx.db
        .update(projects)
        .set({ defaultBranch, updatedAt: Date.now() })
        .where(eq(projects.id, project.id))
        .returning()
        .get()
    }),

  /**
   * Clone a remote into `parentDir` and open the result as a project. The target
   * folder is derived from the URL (last path segment, sans `.git`); if it already
   * exists we refuse rather than clobber. Git is the arbiter of a valid remote —
   * a bad URL surfaces as a clean `BAD_REQUEST` carrying git's own stderr (kept
   * selectable in the UI). On success the clone is verified and upserted.
   */
  clone: publicProcedure.input(cloneInput).mutation(async ({ ctx, input }): Promise<Project> => {
    const parentDir = resolve(input.parentDir)
    const target = join(parentDir, repoDirNameFromUrl(input.url))

    if (await pathExists(target)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `A directory already exists at ${target} — choose another location or remove it first.`,
      })
    }

    // `git clone` creates the leaf dir but not intermediate parents; ensure the
    // destination's parent exists so a fresh location works on the first try.
    await mkdir(parentDir, { recursive: true })

    try {
      // `--` stops the URL/path being parsed as an option. cwd is the parent so
      // the destination is created relative to a directory that already exists.
      await runGit(parentDir, ["clone", "--", input.url, target])
    } catch (error) {
      if (error instanceof GitError) {
        throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error })
      }
      throw error
    }

    return upsertProjectFromDirectory(ctx, target, true, input.details)
  }),

  /**
   * Create a fresh project by copying a template folder into `targetDir`. The
   * template defaults to the user's writable template ({@link
   * resolveWritableTemplateDir}, created empty on first use) but the
   * caller may name any source directory. We refuse to clobber a non-empty target,
   * copy the template's contents in (symlinks preserved, `.DS_Store` and any nested
   * `.git` skipped), `git init` + initial-commit the result unless it already lives
   * in a repo, then verify + upsert through the shared path.
   */
  createFromTemplate: publicProcedure
    .input(createFromTemplateInput)
    .mutation(async ({ ctx, input }): Promise<Project> => {
      let templateDir: string
      if (input.templateDir) {
        templateDir = resolve(input.templateDir)
      } else {
        // Default source: ensure the writable template is seeded, then copy from it.
        await seedWritableTemplate()
        templateDir = resolveWritableTemplateDir()
      }
      const target = resolve(input.targetDir)

      // The template must be an existing directory to copy from.
      const template = await statOrNull(templateDir)
      if (!template?.isDirectory()) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Template not found: ${templateDir}` })
      }

      // Never clobber a non-empty target; an absent or empty directory is fine.
      const existing = await statOrNull(target)
      if (existing) {
        if (!existing.isDirectory() || (await readdir(target)).length > 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `A non-empty directory already exists at ${target} — choose another location or empty it first.`,
          })
        }
      } else {
        await mkdir(target, { recursive: true })
      }

      // Copy the template's contents in, preserving symlinks (e.g. CLAUDE.md ->
      // AGENTS.md) and skipping editor/VCS cruft so the new repo starts clean.
      try {
        if (input.templateFiles || input.externalFiles) {
          await copySelectedInitializationFiles({
            templateDir,
            targetDir: target,
            templateFiles: input.templateFiles ?? [],
            externalFiles: input.externalFiles ?? [],
          })
        } else {
          await cp(templateDir, target, {
            recursive: true,
            verbatimSymlinks: true,
            filter: (src) => {
              const base = basename(src)
              return base !== ".DS_Store" && base !== ".git"
            },
          })
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to copy template into ${target}: ${detail}`,
          cause: error,
        })
      }

      // A copied template carries no `.git` (we skip it), so init + commit unless
      // the target already sits inside a repo — open() needs a real working tree.
      if (!(await isGitRepo(target))) {
        try {
          await runGit(target, ["init", "-b", "main"])
          await runGit(target, ["add", "-A"])
          await runGit(target, ["commit", "--allow-empty", "-m", "Initial commit"])
        } catch (error) {
          if (error instanceof GitError) {
            throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error })
          }
          throw error
        }
      }

      return upsertProjectFromDirectory(ctx, target, false, input.details)
    }),

  /**
   * Every opened project, most-recently-opened first. Archived rows remain in
   * this public list so project-aware surfaces and direct routes keep working;
   * Dashboard and sidebar apply their own presentational visibility filter.
   */
  list: publicProcedure.query(({ ctx }): ProjectSummary[] => {
    const rows = ctx.db
      .select({
        id: projects.id,
        repoPath: projects.repoPath,
        name: projects.name,
        defaultBranch: projects.defaultBranch,
        color: projects.color,
        hasThumbnail: sql<number>`${projects.thumbnail} IS NOT NULL`,
        gradient: projects.gradient,
        digitalRain: projects.digitalRain,
        metadata: projects.metadata,
        taskRelPath: projects.taskRelPath,
        mainRelPath: projects.mainRelPath,
        typeId: projects.typeId,
        agentConfig: projects.agentConfig,
        sortIndex: projects.sortIndex,
        archivedAt: projects.archivedAt,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
        lastOpenedAt: projects.lastOpenedAt,
      })
      .from(projects)
      .orderBy(desc(projects.lastOpenedAt))
      .all()
    return rows.map(({ hasThumbnail, ...fields }) => ({
      ...fields,
      hasThumbnail: Boolean(hasThumbnail),
    }))
  }),

  /** Load one cached artwork variant only when its card or badge is on screen. */
  thumbnail: publicProcedure.input(thumbnailInput).query(async ({ ctx, input }) => {
    const row = ctx.db.select().from(projects).where(eq(projects.id, input.id)).get()
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
    return await readStoredThumbnail(row.thumbnail, input.variant, ctx.thumbnailImageProcessor)
  }),

  /** A single project by id, or throws NOT_FOUND. */
  get: publicProcedure.input(idInput).query(({ ctx, input }): Project => {
    const row = ctx.db.select().from(projects).where(eq(projects.id, input.id)).get()
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
    }
    return row
  }),

  /**
   * Delete a project row (cascades to its worktrees/workspaces via the schema's
   * `onDelete: "cascade"`). The on-disk repo is the user's own and is never
   * touched — PI Lab only forgets it.
   */
  remove: publicProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const daemon = await ctx.getDaemonClient()
    const [sessions, processes] = await Promise.all([daemon.list(), daemon.listProcesses()])
    const projectSessions = new Set(
      ctx.db
        .select({ sessionId: agentSessions.sessionId })
        .from(agentSessions)
        .where(eq(agentSessions.projectId, input.id))
        .all()
        .map((session) => session.sessionId),
    )
    const activeAutomation = ctx.db
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .innerJoin(automations, eq(automationRuns.automationId, automations.id))
      .where(
        and(
          eq(automations.projectId, input.id),
          inArray(automationRuns.state, ["pending", "running"]),
        ),
      )
      .get()
    if (
      activeAutomation ||
      hasPendingAgentLaunch(input.id) ||
      ctx.activityMonitor.liveAgentCount(input.id) > 0 ||
      hasRunningProjectWorkflow(input.id) ||
      sessions.some((session) => session.alive && projectSessions.has(session.id)) ||
      processes.some((process) => process.metadata.projectId === input.id)
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Close this project's agents and wait for background work to finish before removing it",
      })
    }
    ctx.db.delete(projects).where(eq(projects.id, input.id)).run()
    return { ok: true as const }
  }),

  /**
   * Hide or restore a project without deleting its row, files, sessions, or
   * related records. `archivedAt` is the durable hidden-state marker; callers
   * continue receiving archived projects from `list`.
   */
  setArchived: publicProcedure.input(setArchivedInput).mutation(({ ctx, input }): Project => {
    const now = Date.now()
    const row = ctx.db
      .update(projects)
      .set({ archivedAt: input.archived ? now : null, updatedAt: now })
      .where(eq(projects.id, input.id))
      .returning()
      .get()
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
    }
    return row
  }),

  /**
   * Set (or clear, with `dataUrl: null`) the project's dashboard card thumbnail.
   * The renderer drops an image file onto a card and reads it into a `data:` URL,
   * which we persist verbatim; clearing reverts the card to its seeded gradient.
   * Returns the updated row so the dashboard re-renders from the mutation result.
   */
  setThumbnail: publicProcedure.input(setThumbnailInput).mutation(({ ctx, input }): Project => {
    if (input.dataUrl) validateThumbnail(input.dataUrl, ctx.thumbnailImageProcessor)
    const row = ctx.db
      .update(projects)
      // Setting a thumbnail replaces the gradient (one artwork at a time); clearing
      // it (dataUrl: null) leaves the gradient column untouched.
      .set({
        thumbnail: input.dataUrl,
        ...(input.dataUrl ? { gradient: null, digitalRain: false } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(projects.id, input.id))
      .returning()
      .get()
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
    }
    return row
  }),

  /**
   * Persist (or clear, with `gradient: null`) the project's dashboard-card gradient.
   * The renderer samples the current app theme's colors, seeds a gradient, and sends
   * `{ seed, palette }` here so the exact artwork is reproduced on every launch. A
   * non-null gradient also clears the thumbnail — the card shows one artwork at a
   * time, so generating a gradient replaces an imported image. Returns the updated
   * row so the dashboard re-renders from the mutation result.
   */
  setGradient: publicProcedure.input(setGradientInput).mutation(({ ctx, input }): Project => {
    const row = ctx.db
      .update(projects)
      .set({
        gradient: input.gradient,
        ...(input.gradient ? { thumbnail: null, digitalRain: false } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(projects.id, input.id))
      .returning()
      .get()
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
    }
    return row
  }),

  /**
   * Enable the project-owned ASCII Digital Rain artwork. Enabling it replaces
   * the imported image or generated gradient, while disabling it leaves the
   * prior blank artwork state for the renderer to seed a gradient as usual.
   */
  setDigitalRain: publicProcedure.input(setDigitalRainInput).mutation(({ ctx, input }): Project => {
    const row = ctx.db
      .update(projects)
      .set({
        digitalRain: input.enabled,
        ...(input.enabled ? { thumbnail: null, gradient: null } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(projects.id, input.id))
      .returning()
      .get()
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
    }
    return row
  }),

  /**
   * Persist (or clear, with `metadata: null`) the project's extra metadata
   * (collaborators, publishing venue, deadline, emoji tags, reference links) edited
   * via the card's "Edit project…" dialog. The renderer sends the whole group with
   * empty fields already omitted; only filled fields are stored. Returns the updated
   * row so the dashboard re-renders from the mutation result.
   */
  setMetadata: publicProcedure.input(setMetadataInput).mutation(({ ctx, input }): Project => {
    const metadata: ProjectMetadata | null = input.metadata
    const row = ctx.db
      .update(projects)
      .set({ metadata, updatedAt: Date.now() })
      .where(eq(projects.id, input.id))
      .returning()
      .get()
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
    }
    return row
  }),

  /** Remember a project's chosen task source or main Markdown file. */
  setDocumentPath: publicProcedure
    .input(setDocumentPathInput)
    .mutation(async ({ ctx, input }): Promise<Project> => {
      const project = ctx.db.select().from(projects).where(eq(projects.id, input.id)).get()
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
      const path =
        input.relPath === null ? null : await selectedMarkdownPath(project.repoPath, input.relPath)
      const row = ctx.db
        .update(projects)
        .set({
          ...(input.kind === "tasks" ? { taskRelPath: path } : { mainRelPath: path }),
          updatedAt: Date.now(),
        })
        .where(eq(projects.id, project.id))
        .returning()
        .get()
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
      return row
    }),

  updateDetails: publicProcedure
    .input(z.object({ id: z.string().min(1), details: projectDetailsInput }))
    .mutation(async ({ ctx, input }): Promise<Project> => {
      const project = ctx.db.select().from(projects).where(eq(projects.id, input.id)).get()
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
      const agentValues = await saveDetailsAgent(ctx, project, input.details)
      const updated = ctx.db
        .update(projects)
        .set({ ...detailsValues(project, input.details), ...agentValues, updatedAt: Date.now() })
        .where(eq(projects.id, project.id))
        .returning()
        .get()
      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
      return updated
    }),

  /** Select one of the configured types for a project. */
  setType: publicProcedure
    .input(z.object({ id: z.string().min(1), typeId: z.string().min(1) }))
    .mutation(({ ctx, input }): Project => {
      const known = getSettingsOrDefaults(ctx.db).projectTemplate.projectTypes.some(
        (type) => type.id === input.typeId,
      )
      if (!known) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown project type" })
      const row = ctx.db
        .update(projects)
        .set({ typeId: input.typeId, updatedAt: Date.now() })
        .where(eq(projects.id, input.id))
        .returning()
        .get()
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
      return row
    }),

  /** Create TODO.md from the user's template, or empty when no template exists. */
  createTaskFile: publicProcedure
    .input(idInput)
    .mutation(async ({ ctx, input }): Promise<Project> => {
      const project = ctx.db.select().from(projects).where(eq(projects.id, input.id)).get()
      if (!project) throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
      await seedWritableTemplate()
      const source = resolveInsideTemplate(resolveWritableTemplateDir(), "TODO.md")
      const target = join(project.repoPath, "TODO.md")
      try {
        if ((await statOrNull(source))?.isFile()) {
          await copyFile(source, target, constants.COPYFILE_EXCL)
        } else {
          const file = await open(target, "wx")
          await file.close()
        }
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "TODO.md already exists in this project",
          })
        }
        throw error
      }
      return ctx.db
        .update(projects)
        .set({ taskRelPath: "TODO.md", updatedAt: Date.now() })
        .where(eq(projects.id, project.id))
        .returning()
        .get()
    }),

  /** Bump `lastOpenedAt` so the project rises in "recent" ordering. */
  touch: publicProcedure.input(idInput).mutation(({ ctx, input }): Project => {
    const row = ctx.db
      .update(projects)
      .set({ lastOpenedAt: Date.now() })
      .where(eq(projects.id, input.id))
      .returning()
      .get()
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No project ${input.id}` })
    }
    return row
  }),
})

interface CopySelectedInitializationFilesInput {
  templateDir: string
  targetDir: string
  templateFiles: string[]
  externalFiles: string[]
}

/**
 * Copy the files chosen in the template dialog. Template entries are
 * jailed to the configured template; externally picked files may live anywhere
 * but must be ordinary files. Flattening them into the new project's
 * root makes the dialog's displayed file names exactly match what is created.
 */
async function copySelectedInitializationFiles({
  templateDir,
  targetDir,
  templateFiles,
  externalFiles,
}: CopySelectedInitializationFilesInput): Promise<void> {
  const copiedNames = new Set<string>()
  const sources = [
    ...templateFiles.map((relPath) => ({
      path: resolveInsideTemplate(templateDir, relPath),
      label: relPath,
    })),
    ...externalFiles.map((filePath) => ({ path: resolve(filePath), label: filePath })),
  ]

  for (const source of sources) {
    const info = await statOrNull(source.path)
    if (!info?.isFile()) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Initialization file not found: ${source.label}`,
      })
    }
    const name = basename(source.path)
    if (copiedNames.has(name)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `Two initialization files have the same name: ${name}`,
      })
    }
    copiedNames.add(name)
    await cp(source.path, join(targetDir, name), { verbatimSymlinks: true })
  }
}
