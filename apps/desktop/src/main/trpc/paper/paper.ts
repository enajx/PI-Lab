import { existsSync } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"
import {
  type PiLabDatabase,
  type Project,
  type ProjectPaper,
  projects,
  resolveDataDir,
  serviceCredentials,
  type Workspace,
  workspaces,
} from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { isGitRepo, repoRoot, runGit, status } from "../../git"
import {
  addLocalExclude,
  clone,
  commitAll,
  conflictedFiles,
  conflictStages,
  isMerging,
  pull,
  push,
  pushUrl,
  type RemoteCallOptions,
  remoteUrl,
  takeSide,
  unresolvedFiles,
} from "../../git/remote"
import { findRootTex, listPaperFiles, type PaperFile, readPaperText } from "../../paper/files"
import { buildOutline, type OutlineEntry } from "../../paper/outline"
import {
  displayRemoteUrl,
  isOverleafUrl,
  OVERLEAF_TOKEN_REQUIRED,
  remoteEnv,
  writeAskpassScript,
} from "../../paper/overleaf"
import type { AppContext } from "../context"
import { publicProcedure, router } from "../trpc"

/**
 * Paper router: the LaTeX Editor page links one paper folder per project,
 * either an Overleaf project cloned into `<project>/paper/` or a folder the
 * user already has. The link lives in the project's `metadata.paper`, and a
 * hidden workspace of kind "paper" points at the folder so the files and pdf
 * routers work on it. Sync pulls and pushes inside the paper folder only; the
 * project's own repository is never committed to.
 */

/** `service_credentials` key for the one Overleaf Git token. */
const OVERLEAF_SERVICE = "overleaf"

/** Commit message for unsent edits committed by Sync. */
const SYNC_COMMIT_MESSAGE = "Sync from PI Lab"

/** The linked paper folder as the renderer sees it. */
export interface PaperView {
  dir: string
  remoteUrl: string | null
  lastSyncAt: number | null
  isOverleaf: boolean
}

/** Result of `paper.get`, `paper.link` and `paper.addOverleaf`. */
export interface PaperState {
  paper: PaperView | null
  /** Id of the hidden paper workspace, for files.* and pdf.* calls. */
  workspaceId: string | null
  /** Main .tex file relative to the paper folder, or null when it cannot be chosen. */
  rootRelPath: string | null
}

/** Result of `paper.sync` and `paper.resolve`. */
export type SyncResult =
  | { state: "needs-commit"; changedFiles: string[] }
  | { state: "conflict"; files: string[] }
  | { state: "synced"; lastSyncAt: number }
  | { state: "no-remote" }

const projectIdInput = z.object({ projectId: z.string().min(1) })

/** Load a project or throw NOT_FOUND. */
function requireProject(db: PiLabDatabase, projectId: string): Project {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: `No project ${projectId}` })
  return project
}

/** The project's linked paper folder, or PRECONDITION_FAILED when none is linked. */
function requirePaper(project: Project): ProjectPaper {
  const paper = project.metadata?.paper
  if (!paper) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "No paper folder is linked to this project",
    })
  }
  return paper
}

/** Store (or remove, with null) the project's paper link, keeping the other metadata. */
function writePaper(db: PiLabDatabase, projectId: string, paper: ProjectPaper | null): void {
  const project = requireProject(db, projectId)
  const { paper: _old, ...rest } = project.metadata ?? {}
  const metadata = paper ? { ...rest, paper } : rest
  db.update(projects)
    .set({ metadata, updatedAt: Date.now() })
    .where(eq(projects.id, projectId))
    .run()
}

/** The project's hidden paper workspace, if any. */
function paperWorkspace(db: PiLabDatabase, projectId: string): Workspace | null {
  return (
    db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.projectId, projectId), eq(workspaces.kind, "paper")))
      .get() ?? null
  )
}

/** True when `dir` is the top folder of its own Git repository (not a subfolder of another repo). */
async function isOwnRepo(dir: string): Promise<boolean> {
  if (!(await isGitRepo(dir))) return false
  return (await realpath(await repoRoot(dir))) === (await realpath(dir))
}

/** Current paper state for a project. */
async function paperState(db: PiLabDatabase, projectId: string): Promise<PaperState> {
  const paper = requireProject(db, projectId).metadata?.paper
  if (!paper) return { paper: null, workspaceId: null, rootRelPath: null }
  const files = await listPaperFiles(paper.dir)
  return {
    paper: {
      dir: paper.dir,
      remoteUrl: paper.remoteUrl,
      lastSyncAt: paper.lastSyncAt,
      isOverleaf: paper.remoteUrl !== null && isOverleafUrl(paper.remoteUrl),
    },
    workspaceId: paperWorkspace(db, projectId)?.id ?? null,
    rootRelPath: await findRootTex(paper.dir, files),
  }
}

/** Build output from the PDF build, kept out of the paper repo's commits. */
const BUILD_EXCLUDE = "build/"

/** True when `dir` is `inner` or one of its parent folders. Both paths must be real paths. */
function containsOrEquals(dir: string, inner: string): boolean {
  const rel = relative(dir, inner)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Link an existing folder as the project's paper folder, replacing any earlier
 * link. The folder must exist and be a directory, and must not be the project
 * folder or a folder that contains it (Sync would then commit the project
 * repo). When the folder is the top of its own Git repository, its `origin`
 * URL is recorded without any embedded credentials, and `build/` is added to
 * that repo's local `.git/info/exclude` so PDF build output is never committed.
 */
export async function linkPaper(
  db: PiLabDatabase,
  projectId: string,
  dir: string,
): Promise<PaperState> {
  const project = requireProject(db, projectId)
  if (!existsSync(dir) || !(await stat(dir)).isDirectory()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Not a folder: ${dir}` })
  }
  const canonical = await realpath(dir)
  if (containsOrEquals(canonical, await realpath(project.repoPath))) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "The paper folder cannot be the project folder or a folder that contains it. Choose the paper's own folder.",
    })
  }
  const ownRepo = await isOwnRepo(canonical)
  if (ownRepo) await addLocalExclude(canonical, BUILD_EXCLUDE)
  const origin = ownRepo ? await remoteUrl(canonical) : null
  const url = origin === null ? null : displayRemoteUrl(origin)
  db.transaction(
    (tx) => {
      tx.delete(workspaces)
        .where(and(eq(workspaces.projectId, projectId), eq(workspaces.kind, "paper")))
        .run()
      tx.insert(workspaces)
        .values({ projectId, kind: "paper", name: "Paper", branch: "paper", portBase: null })
        .run()
    },
    { behavior: "immediate" },
  )
  writePaper(db, projectId, { dir: canonical, remoteUrl: url, lastSyncAt: null })
  return paperState(db, projectId)
}

/** Add `/<path>/` for `target` to the project repo's `.git/info/exclude` (never .gitignore). */
async function excludeFromProjectRepo(repoPath: string, target: string): Promise<void> {
  const root = await realpath(await repoRoot(repoPath))
  const rel = relative(root, await realpath(target))
    .split(sep)
    .join("/")
  await addLocalExclude(repoPath, `/${rel}/`)
}

/**
 * Clone `url` into `<project>/paper`, hide that folder from the project's own
 * Git repo (via `.git/info/exclude`) when the project is a Git repo, and link
 * it. Refuses when `<project>/paper` already exists.
 */
export async function clonePaper(
  db: PiLabDatabase,
  projectId: string,
  url: string,
  options: RemoteCallOptions,
): Promise<PaperState> {
  const project = requireProject(db, projectId)
  const target = join(project.repoPath, "paper")
  if (existsSync(target)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `${target} already exists. Use the existing folder or move it first.`,
    })
  }
  await clone(project.repoPath, url, target, options)
  if (await isGitRepo(project.repoPath)) await excludeFromProjectRepo(project.repoPath, target)
  return linkPaper(db, projectId, target)
}

/** Decrypt the saved Overleaf token, or null when none is saved. */
function readToken(ctx: AppContext): string | null {
  const row = ctx.db
    .select()
    .from(serviceCredentials)
    .where(eq(serviceCredentials.service, OVERLEAF_SERVICE))
    .get()
  return row ? ctx.credentialCipher.decrypt(row.encryptedValue) : null
}

/** True when an Overleaf token is saved (does not decrypt it). */
function tokenConfigured(db: PiLabDatabase): boolean {
  return (
    db
      .select({ service: serviceCredentials.service })
      .from(serviceCredentials)
      .where(eq(serviceCredentials.service, OVERLEAF_SERVICE))
      .get() !== undefined
  )
}

/**
 * Git env for a remote call to `urls` (fetch and push URLs). Reads the token
 * and writes the askpass script only when every URL is Overleaf.
 */
async function remoteOptions(ctx: AppContext, urls: string[]): Promise<RemoteCallOptions> {
  if (!urls.every(isOverleafUrl)) return { env: remoteEnv(urls, null, "") }
  const token = readToken(ctx)
  if (!token) throw new TRPCError({ code: "PRECONDITION_FAILED", message: OVERLEAF_TOKEN_REQUIRED })
  const askpass = await writeAskpassScript(join(resolveDataDir(), "git"))
  return { env: remoteEnv(urls, token, askpass) }
}

/** Git env for sync calls in `dir`, from its `origin` fetch and push URLs. */
async function originOptions(
  ctx: AppContext,
  dir: string,
  fetchUrl: string,
): Promise<RemoteCallOptions> {
  return remoteOptions(ctx, [fetchUrl, await pushUrl(dir)])
}

/** Record a successful sync and return the synced result. */
function markSynced(db: PiLabDatabase, projectId: string): SyncResult {
  const paper = requirePaper(requireProject(db, projectId))
  const lastSyncAt = Date.now()
  writePaper(db, projectId, { ...paper, lastSyncAt })
  return { state: "synced", lastSyncAt }
}

/** Stage the resolved files, finish the merge commit, push, and record the sync. */
async function finishMerge(
  db: PiLabDatabase,
  projectId: string,
  dir: string,
  files: string[],
  options: RemoteCallOptions,
): Promise<SyncResult> {
  if (files.length > 0) await runGit(dir, ["add", "--", ...files], {})
  await runGit(dir, ["commit", "--no-edit"], {})
  await push(dir, options)
  return markSynced(db, projectId)
}

/** The paper folder and its remote, or null when it has no remote to sync with. */
async function syncTarget(
  db: PiLabDatabase,
  projectId: string,
): Promise<{ dir: string; url: string } | null> {
  const dir = requirePaper(requireProject(db, projectId)).dir
  if (!(await isOwnRepo(dir))) return null
  const url = await remoteUrl(dir)
  return url ? { dir, url } : null
}

/**
 * Sync the paper folder with its remote. A merge left by an earlier sync is
 * finished once no conflict markers remain. Otherwise unsent edits are
 * committed (only when `commit` is true), the remote is merged in, and the
 * result is pushed.
 */
async function syncPaper(ctx: AppContext, projectId: string, commit: boolean): Promise<SyncResult> {
  const target = await syncTarget(ctx.db, projectId)
  if (!target) return { state: "no-remote" }
  const { dir, url } = target
  const options = await originOptions(ctx, dir, url)
  if (await isMerging(dir)) {
    const files = await conflictedFiles(dir)
    const unresolved = await unresolvedFiles(dir, files)
    if (unresolved.length > 0) return { state: "conflict", files: unresolved }
    return finishMerge(ctx.db, projectId, dir, files, options)
  }
  const changedFiles = (await status(dir)).map((change) => change.path)
  if (changedFiles.length > 0) {
    if (!commit) return { state: "needs-commit", changedFiles }
    await commitAll(dir, SYNC_COMMIT_MESSAGE)
  }
  if ((await pull(dir, options)) === "conflict") {
    return { state: "conflict", files: await conflictedFiles(dir) }
  }
  await push(dir, options)
  return markSynced(ctx.db, projectId)
}

/**
 * Settle a merge conflict. "mine"/"overleaf" take one side for every
 * conflicted file (deleting files that side deleted), then commit and push.
 * "restore-conflicts" puts the conflict markers back in files both sides
 * changed (after a rejected agent merge) and leaves the merge open.
 */
async function resolvePaper(
  ctx: AppContext,
  projectId: string,
  choice: "mine" | "overleaf" | "restore-conflicts",
): Promise<SyncResult> {
  const target = await syncTarget(ctx.db, projectId)
  if (!target || !(await isMerging(target.dir))) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No merge is in progress" })
  }
  const { dir, url } = target
  if (choice === "restore-conflicts") {
    const stages = await conflictStages(dir)
    const bothSides = [...stages].filter(([, sides]) => sides.ours && sides.theirs)
    const paths = bothSides.map(([path]) => path)
    if (paths.length > 0) await runGit(dir, ["checkout", "--merge", "--", ...paths], {})
    return { state: "conflict", files: [...stages.keys()] }
  }
  const options = await originOptions(ctx, dir, url)
  await takeSide(dir, choice === "mine" ? "ours" : "theirs")
  return finishMerge(ctx.db, projectId, dir, [], options)
}

const tokenRouter = router({
  /** Whether an Overleaf token is saved. The token itself is never returned. */
  status: publicProcedure.query(({ ctx }): { configured: boolean } => ({
    configured: tokenConfigured(ctx.db),
  })),

  /** Save (or replace) the Overleaf Git token, encrypted with the OS keychain. */
  set: publicProcedure
    .input(z.object({ token: z.string().trim().min(1).max(4096) }))
    .mutation(({ ctx, input }): { configured: boolean } => {
      const encryptedValue = ctx.credentialCipher.encrypt(input.token)
      const updatedAt = Date.now()
      ctx.db
        .insert(serviceCredentials)
        .values({ service: OVERLEAF_SERVICE, encryptedValue, updatedAt })
        .onConflictDoUpdate({
          target: serviceCredentials.service,
          set: { encryptedValue, updatedAt },
        })
        .run()
      return { configured: true }
    }),

  /** Delete the saved Overleaf token. */
  clear: publicProcedure.mutation(({ ctx }): { configured: boolean } => {
    ctx.db.delete(serviceCredentials).where(eq(serviceCredentials.service, OVERLEAF_SERVICE)).run()
    return { configured: false }
  }),
})

export const paperRouter = router({
  /** The project's linked paper folder, its hidden workspace id, and its main .tex file. */
  get: publicProcedure
    .input(projectIdInput)
    .query(({ ctx, input }): Promise<PaperState> => paperState(ctx.db, input.projectId)),

  /** LaTeX sources and figures in the paper folder (skips build/ and hidden folders). */
  files: publicProcedure.input(projectIdInput).query(({ ctx, input }): Promise<PaperFile[]> => {
    const paper = requirePaper(requireProject(ctx.db, input.projectId))
    return listPaperFiles(paper.dir)
  }),

  /** Section outline of the paper, from its main .tex file through \input and \include. */
  outline: publicProcedure
    .input(projectIdInput)
    .query(async ({ ctx, input }): Promise<OutlineEntry[]> => {
      const paper = requirePaper(requireProject(ctx.db, input.projectId))
      const root = await findRootTex(paper.dir, await listPaperFiles(paper.dir))
      if (!root) return []
      return buildOutline(root, (relPath) => readPaperText(paper.dir, relPath))
    }),

  /** Link a folder the user already has (inside or outside the project folder). */
  link: publicProcedure
    .input(z.object({ projectId: z.string().min(1), dir: z.string().min(1) }))
    .mutation(
      ({ ctx, input }): Promise<PaperState> => linkPaper(ctx.db, input.projectId, input.dir),
    ),

  /** Clone an Overleaf project into `<project>/paper` with the saved token, then link it. */
  addOverleaf: publicProcedure
    .input(z.object({ projectId: z.string().min(1), url: z.string().trim().min(1) }))
    .mutation(async ({ ctx, input }): Promise<PaperState> => {
      if (!isOverleafUrl(input.url)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Enter an Overleaf Git URL (https://git.overleaf.com/…)",
        })
      }
      if (!tokenConfigured(ctx.db)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: OVERLEAF_TOKEN_REQUIRED })
      }
      const project = requireProject(ctx.db, input.projectId)
      if (existsSync(join(project.repoPath, "paper"))) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `${join(project.repoPath, "paper")} already exists. Use the existing folder or move it first.`,
        })
      }
      return clonePaper(ctx.db, input.projectId, input.url, await remoteOptions(ctx, [input.url]))
    }),

  /** Remove the link and the hidden paper workspace. Never deletes files. */
  unlink: publicProcedure.input(projectIdInput).mutation(({ ctx, input }): { ok: true } => {
    requireProject(ctx.db, input.projectId)
    ctx.db
      .delete(workspaces)
      .where(and(eq(workspaces.projectId, input.projectId), eq(workspaces.kind, "paper")))
      .run()
    writePaper(ctx.db, input.projectId, null)
    return { ok: true }
  }),

  token: tokenRouter,

  /** Pull and push the paper folder; see {@link syncPaper}. */
  sync: publicProcedure
    .input(z.object({ projectId: z.string().min(1), commit: z.boolean() }))
    .mutation(
      ({ ctx, input }): Promise<SyncResult> => syncPaper(ctx, input.projectId, input.commit),
    ),

  /** Settle a merge conflict; see {@link resolvePaper}. */
  resolve: publicProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        choice: z.enum(["mine", "overleaf", "restore-conflicts"]),
      }),
    )
    .mutation(
      ({ ctx, input }): Promise<SyncResult> => resolvePaper(ctx, input.projectId, input.choice),
    ),
})
