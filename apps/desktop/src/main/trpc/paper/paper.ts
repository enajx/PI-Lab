import { existsSync } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import {
  getSettingsOrDefaults,
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
import { findOverleafClones, isOverleafClone, type OverleafCloneSearch } from "../../paper/detect"
import { findRootTex, listPaperFiles, readPaperText } from "../../paper/files"
import { buildOutline, type OutlineEntry } from "../../paper/outline"
import {
  effectiveOutputDir,
  excludeEffectiveOutputs,
  isOwnRepo,
  outputDirOrBadRequest,
  requireUntrackedOutputDir,
} from "../../paper/outputs"
import {
  displayRemoteUrl,
  gitHasOverleafCredential,
  isOverleafUrl,
  OVERLEAF_TOKEN_REQUIRED,
  type OverleafAuth,
  type OverleafTokenStatus,
  remoteEnv,
  requireSyncEnabled,
  writeAskpassScript,
} from "../../paper/overleaf"
import type { AppContext } from "../context"
import { publicProcedure, router } from "../trpc"

/**
 * Paper router: the LaTeX Editor page links one paper folder per project,
 * either an Overleaf project cloned into `<project>/paper/` or a folder the
 * user already has. The link lives in the project's `metadata.paper`, and a
 * hidden workspace of kind "paper" points at the folder so the files and pdf
 * routers work on it. Sync pulls and pushes inside the paper folder only. The
 * paper folder may be the project folder itself: always when it is an Overleaf
 * clone, otherwise only after the user chose whether Sync is on for it.
 */

/** `service_credentials` key for the one Overleaf Git token. */
const OVERLEAF_SERVICE = "overleaf"

/** Commit message for unsent edits committed by Sync. */
const SYNC_COMMIT_MESSAGE = "Sync from PI Lab"

/** The linked paper folder as the renderer sees it. */
export interface PaperView {
  dir: string
  /** The folder as shown to the user; see {@link displayPaperDir}. */
  displayDir: string
  remoteUrl: string | null
  lastSyncAt: number | null
  isOverleaf: boolean
  /** This paper's own build output folder, or null when it uses the global default. */
  outputDir: string | null
  /** The build output folder its builds use (the override, else the global default). */
  effectiveOutputDir: string
  /** False when the paper is linked for editing and building only; Sync then refuses to run. */
  syncEnabled: boolean
}

/**
 * The user's choice for linking a project folder that is not an Overleaf
 * clone: "sync" links it normally, "no-sync" links it with Sync off.
 */
export type RootChoice = "sync" | "no-sync"

/** Result of `paper.checkFolder`: what linking a folder would mean. */
export interface FolderCheck {
  /** The folder as shown to the user; see {@link displayPaperDir}. */
  displayDir: string
  /** True when the folder is the project folder itself. */
  projectFolder: boolean
  /** True when the folder is the top of its own repo with an Overleaf `origin`. */
  overleaf: boolean
  /** The folder's `origin` URL without credentials, or null when it has none (or is not its own repo). */
  remoteUrl: string | null
}

/** Error message for a non-Overleaf project folder linked without a choice. */
const ROOT_CHOICE_REQUIRED =
  "This is the project folder and it is not an Overleaf clone. Sync would commit and push the whole project, so choose whether Sync is on for this paper."

/** Error message for a project folder with no remote linked with Sync on. */
const ROOT_SYNC_NO_REMOTE =
  "The project folder has no Git remote, so Sync cannot run. Use it for editing and building only, or choose another folder."

/** Result of `paper.get`, `paper.link` and `paper.addOverleaf`. */
export interface PaperState {
  paper: PaperView | null
  /** Id of the hidden paper workspace, for files.* and pdf.* calls. */
  workspaceId: string | null
  /** Main .tex file relative to the paper folder, or null when it cannot be chosen. */
  rootRelPath: string | null
  /** False after the user cleared the paper folder: the LaTeX Editor then does not look for Overleaf clones. */
  autoDetect: boolean
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
      message: "This project has no paper folder",
    })
  }
  return paper
}

/**
 * Store the project's paper link, keeping the other metadata, or remove it
 * with null. Removing it also turns auto-detection off (`paperAutoDetect:
 * false`); storing one turns it back on.
 */
function writePaper(db: PiLabDatabase, projectId: string, paper: ProjectPaper | null): void {
  const project = requireProject(db, projectId)
  const { paper: _old, paperAutoDetect: _flag, ...rest } = project.metadata ?? {}
  const metadata = paper ? { ...rest, paper } : { ...rest, paperAutoDetect: false }
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

/**
 * How a paper folder is shown to the user: "." for the project folder, the
 * path relative to the project folder when inside it, else the full path with
 * `~` for the home folder. All paths must be real paths.
 */
export function displayPaperDir(dir: string, projectDir: string, home: string): string {
  if (containsOrEquals(projectDir, dir)) {
    const rel = relative(projectDir, dir)
    return rel === "" ? "." : rel.split(sep).join("/")
  }
  if (containsOrEquals(home, dir)) {
    const rel = relative(home, dir)
    return rel === "" ? "~" : `~/${rel.split(sep).join("/")}`
  }
  return dir
}

/** {@link displayPaperDir} for a project's folder and the user's home folder. */
async function displayDirFor(project: Project, dir: string): Promise<string> {
  // A missing project folder cannot be resolved; its stored path is compared as is.
  const projectDir = existsSync(project.repoPath)
    ? await realpath(project.repoPath)
    : project.repoPath
  const home = existsSync(homedir()) ? await realpath(homedir()) : homedir()
  return displayPaperDir(dir, projectDir, home)
}

/** Current paper state for a project. */
async function paperState(db: PiLabDatabase, projectId: string): Promise<PaperState> {
  const project = requireProject(db, projectId)
  const paper = project.metadata?.paper
  const autoDetect = project.metadata?.paperAutoDetect !== false
  if (!paper) return { paper: null, workspaceId: null, rootRelPath: null, autoDetect }
  const files = await listPaperFiles(paper.dir)
  return {
    autoDetect,
    paper: {
      dir: paper.dir,
      displayDir: await displayDirFor(project, paper.dir),
      remoteUrl: paper.remoteUrl,
      lastSyncAt: paper.lastSyncAt,
      isOverleaf: paper.remoteUrl !== null && isOverleafUrl(paper.remoteUrl),
      outputDir: paper.outputDir ?? null,
      effectiveOutputDir: effectiveOutputDir(
        paper,
        getSettingsOrDefaults(db).editor.latexOutputDir,
      ),
      syncEnabled: paper.syncEnabled !== false,
    },
    workspaceId: paperWorkspace(db, projectId)?.id ?? null,
    rootRelPath: await findRootTex(paper.dir, files),
  }
}

/** True when `dir` is `inner` or one of its parent folders. Both paths must be real paths. */
function containsOrEquals(dir: string, inner: string): boolean {
  const rel = relative(dir, inner)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The real path of an existing folder, or BAD_REQUEST when `dir` is missing or not a folder. */
async function requireFolder(dir: string): Promise<string> {
  if (!existsSync(dir) || !(await stat(dir)).isDirectory()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Not a folder: ${dir}` })
  }
  return realpath(dir)
}

/** What linking `dir` as the paper folder would mean; see {@link FolderCheck}. */
async function checkFolder(
  db: PiLabDatabase,
  projectId: string,
  dir: string,
): Promise<FolderCheck> {
  const project = requireProject(db, projectId)
  const canonical = await requireFolder(dir)
  const origin = (await isOwnRepo(canonical)) ? await remoteUrl(canonical) : null
  return {
    displayDir: await displayDirFor(project, canonical),
    projectFolder: canonical === (await realpath(project.repoPath)),
    overleaf: await isOverleafClone(canonical),
    remoteUrl: origin === null ? null : displayRemoteUrl(origin),
  }
}

/**
 * Link an existing folder as the project's paper folder, replacing any earlier
 * link. The folder must exist and be a directory. A folder that contains the
 * project folder is refused. The project folder itself is accepted when it is
 * an Overleaf clone; otherwise `rootChoice` must say whether Sync is on for it
 * (Sync would commit and push the whole project): "sync" needs a Git remote,
 * and "no-sync" stores Sync as off. When the folder is the top of its own Git
 * repository, its `origin` URL is recorded without any embedded credentials,
 * and (unless Sync is off) the build output folder is added to that repo's
 * local `.git/info/exclude` so PDF build output is never committed. The previous link's output folder override is kept when
 * the same folder is linked again.
 */
export async function linkPaper(
  db: PiLabDatabase,
  projectId: string,
  dir: string,
  rootChoice: RootChoice | null,
): Promise<PaperState> {
  const project = requireProject(db, projectId)
  const canonical = await requireFolder(dir)
  const projectDir = await realpath(project.repoPath)
  const isProjectFolder = canonical === projectDir
  if (!isProjectFolder && containsOrEquals(canonical, projectDir)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "The paper folder cannot be a folder that contains the project folder. Choose the paper's own folder or the project folder.",
    })
  }
  const ownRepo = await isOwnRepo(canonical)
  const origin = ownRepo ? await remoteUrl(canonical) : null
  const askRoot = isProjectFolder && !(await isOverleafClone(canonical))
  if (askRoot && rootChoice === null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: ROOT_CHOICE_REQUIRED })
  }
  if (askRoot && rootChoice === "sync" && origin === null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: ROOT_SYNC_NO_REMOTE })
  }
  const syncOff = askRoot && rootChoice === "no-sync"
  const previous = project.metadata?.paper
  const outputDir = previous?.dir === canonical ? previous.outputDir : undefined
  const paper: ProjectPaper = { dir: canonical, remoteUrl: null, lastSyncAt: null }
  if (outputDir !== undefined) paper.outputDir = outputDir
  if (syncOff) paper.syncEnabled = false
  await excludeEffectiveOutputs(paper, getSettingsOrDefaults(db).editor.latexOutputDir)
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
  writePaper(db, projectId, { ...paper, remoteUrl: url })
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
  return linkPaper(db, projectId, target, null)
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
 * Where the Overleaf credential comes from: a saved token wins (checked
 * without decrypting it), else a credential the user's own Git has for
 * git.overleaf.com. The secret is never part of the result.
 */
async function tokenStatus(db: PiLabDatabase): Promise<OverleafTokenStatus> {
  if (tokenConfigured(db)) return { configured: true, source: "saved" }
  if (await gitHasOverleafCredential(process.env)) return { configured: true, source: "git" }
  return { configured: false, source: null }
}

/**
 * Git env for a remote call to `urls` (fetch and push URLs). Only when every
 * URL is Overleaf does it read the saved token and write the askpass script,
 * or, with no saved token, check the user's Git for a credential.
 */
async function remoteOptions(ctx: AppContext, urls: string[]): Promise<RemoteCallOptions> {
  if (!urls.every(isOverleafUrl)) return { env: remoteEnv(urls, null) }
  return { env: remoteEnv(urls, await overleafAuth(ctx)) }
}

/** How Overleaf git calls authenticate now; see {@link OverleafAuth}. */
async function overleafAuth(ctx: AppContext): Promise<OverleafAuth> {
  const token = readToken(ctx)
  if (token) {
    const askpassPath = await writeAskpassScript(join(resolveDataDir(), "git"))
    return { source: "saved", token, askpassPath }
  }
  return (await gitHasOverleafCredential(process.env)) ? { source: "git" } : null
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

/**
 * The paper folder and its remote, or null when it has no remote to sync with.
 * Throws PRECONDITION_FAILED when Sync is off for the paper.
 */
async function syncTarget(
  db: PiLabDatabase,
  projectId: string,
): Promise<{ dir: string; url: string } | null> {
  const paper = requirePaper(requireProject(db, projectId))
  requireSyncEnabled(paper.syncEnabled)
  const dir = paper.dir
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
  /**
   * Whether an Overleaf credential is available and where it comes from (a
   * saved token wins over the user's Git). The secret itself is never returned.
   */
  status: publicProcedure.query(({ ctx }): Promise<OverleafTokenStatus> => tokenStatus(ctx.db)),

  /** Save (or replace) the Overleaf Git token, encrypted with the OS keychain. */
  set: publicProcedure
    .input(z.object({ token: z.string().trim().min(1).max(4096) }))
    .mutation(({ ctx, input }): OverleafTokenStatus => {
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
      return { configured: true, source: "saved" }
    }),

  /** Delete the saved Overleaf token and return the status after it (Git may still have one). */
  clear: publicProcedure.mutation(({ ctx }): Promise<OverleafTokenStatus> => {
    ctx.db.delete(serviceCredentials).where(eq(serviceCredentials.service, OVERLEAF_SERVICE)).run()
    return tokenStatus(ctx.db)
  }),
})

export const paperRouter = router({
  /** The project's linked paper folder, its hidden workspace id, and its main .tex file. */
  get: publicProcedure
    .input(projectIdInput)
    .query(({ ctx, input }): Promise<PaperState> => paperState(ctx.db, input.projectId)),

  /** Section outline of the paper, from its main .tex file through \input and \include. */
  outline: publicProcedure
    .input(projectIdInput)
    .query(async ({ ctx, input }): Promise<OutlineEntry[]> => {
      const paper = requirePaper(requireProject(ctx.db, input.projectId))
      const root = await findRootTex(paper.dir, await listPaperFiles(paper.dir))
      if (!root) return []
      return buildOutline(root, (relPath) => readPaperText(paper.dir, relPath))
    }),

  /**
   * Overleaf clones in the project: the project folder itself and folders a few
   * levels inside it, and whether the search stopped early. The LaTeX Editor
   * links the paper from these when the project has none linked.
   */
  detect: publicProcedure
    .input(projectIdInput)
    .query(
      async ({ ctx, input }): Promise<OverleafCloneSearch> =>
        findOverleafClones(await realpath(requireProject(ctx.db, input.projectId).repoPath)),
    ),

  /** What linking a folder would mean (project folder, Overleaf clone, remote URL). */
  checkFolder: publicProcedure
    .input(z.object({ projectId: z.string().min(1), dir: z.string().min(1) }))
    .query(
      ({ ctx, input }): Promise<FolderCheck> => checkFolder(ctx.db, input.projectId, input.dir),
    ),

  /**
   * Link a folder the user already has (inside or outside the project folder,
   * or the project folder itself; see {@link linkPaper} for `rootChoice`).
   */
  link: publicProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        dir: z.string().min(1),
        rootChoice: z.enum(["sync", "no-sync"]).nullable(),
      }),
    )
    .mutation(
      ({ ctx, input }): Promise<PaperState> =>
        linkPaper(ctx.db, input.projectId, input.dir, input.rootChoice),
    ),

  /**
   * Clone an Overleaf project into `<project>/paper` with the saved token (or
   * the user's Git credential when no token is saved), then link it.
   */
  addOverleaf: publicProcedure
    .input(z.object({ projectId: z.string().min(1), url: z.string().trim().min(1) }))
    .mutation(async ({ ctx, input }): Promise<PaperState> => {
      if (!isOverleafUrl(input.url)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Enter an Overleaf Git URL (https://git.overleaf.com/…)",
        })
      }
      if (!(await tokenStatus(ctx.db)).configured) {
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

  /**
   * Set this paper's build output folder (relative to its root .tex file's
   * folder, "." for next to it), or clear it with "" to use the global
   * default. The new effective folder is added to the paper repo's local
   * `.git/info/exclude` so Sync never commits the output.
   */
  setOutputDir: publicProcedure
    .input(z.object({ projectId: z.string().min(1), outputDir: z.string().max(512) }))
    .mutation(async ({ ctx, input }): Promise<PaperState> => {
      const paper = requirePaper(requireProject(ctx.db, input.projectId))
      const { outputDir: _old, ...rest } = paper
      const next: ProjectPaper =
        input.outputDir.trim() === ""
          ? rest
          : { ...rest, outputDir: outputDirOrBadRequest(input.outputDir) }
      if (next.outputDir !== undefined) await requireUntrackedOutputDir(next.dir, next.outputDir)
      await excludeEffectiveOutputs(next, getSettingsOrDefaults(ctx.db).editor.latexOutputDir)
      writePaper(ctx.db, input.projectId, next)
      return paperState(ctx.db, input.projectId)
    }),

  /**
   * Remove the link and the hidden paper workspace, and turn auto-detection
   * off until a folder is chosen again. Never deletes files.
   */
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
