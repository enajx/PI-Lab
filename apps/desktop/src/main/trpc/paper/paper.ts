import { existsSync } from "node:fs"
import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
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
  type ConflictKind,
  clone,
  commitAll,
  conflictedFiles,
  conflictKinds,
  conflictStages,
  currentBranch,
  isMerging,
  mergeUnrelatedKeepingOurs,
  pull,
  push,
  pushSetUpstream,
  pushUrl,
  type RemoteCallOptions,
  remoteDefaultBranch,
  remoteUrl,
  takeSide,
  takeSideOf,
  unresolvedFiles,
} from "../../git/remote"
import {
  findOverleafClones,
  findPapersInside,
  isOverleafClone,
  isPaperFolder,
  type OverleafCloneSearch,
  type PaperCandidate,
} from "../../paper/detect"
import { listPaperFiles, readPaperText } from "../../paper/files"
import { buildOutline, type OutlineEntry } from "../../paper/outline"
import {
  effectiveOutputDir,
  excludeEffectiveOutputs,
  isOwnRepo,
  mainDocOf,
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
  overleafUrlProblem,
  remoteEnv,
  requireSyncEnabled,
  writeAskpassScript,
} from "../../paper/overleaf"
import {
  clearCustomTemplate,
  setCustomTemplate,
  type TemplateStatus,
  templateStatus,
  writeTemplate,
} from "../../paper/template"
import type { AppContext } from "../context"
import { addPaperOnlyProject, projectsRouter } from "../projects/projects"
import { publicProcedure, router } from "../trpc"
import { type StartUpdatePaperResult, startUpdatePaper } from "./updatePaper"

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

/** Commit message for a paper created from the LaTeX template. */
const CREATE_COMMIT_MESSAGE = "Create paper from template"

/** Commit message for merging a Blank Overleaf project into a local paper. */
const CONNECT_COMMIT_MESSAGE = "Connect to Overleaf"

/** Result of `paper.createTarget`: where "Start draft" puts the paper unless the user chooses. */
export interface CreateTarget {
  /** `<project>/paper`, or the first of `<project>/paper-2`, `paper-3`, … that can be used. */
  dir: string
  /** The folder as shown to the user; see {@link displayPaperDir}. */
  displayDir: string
}

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
  /** True when the saved folder no longer exists (moved, renamed or deleted). */
  missing: boolean
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
  /** True when it can be a paper folder: a .tex file at its top level, or an Overleaf clone. */
  isPaper: boolean
  /** When it is not a paper folder: the folders inside it that can be (else empty). */
  inside: PaperCandidate[]
  /** True when the search inside it stopped early, so papers may be missing. */
  stoppedEarly: boolean
}

/** Error message for a non-Overleaf project folder linked without a choice. */
const ROOT_CHOICE_REQUIRED =
  "This is the project folder and it is not an Overleaf clone. Sync would commit and push the whole project, so choose whether Sync is on for this paper."

/** Error message for a folder that cannot be a paper folder. */
const NOT_A_PAPER =
  "This folder is not a paper folder: it has no .tex file at its top level and is not an Overleaf clone. Choose the paper's own folder."

/** Error message for a project folder with no remote linked with Sync on. */
const ROOT_SYNC_NO_REMOTE =
  "The project folder has no Git remote, so Sync cannot run. Use it for editing and building only, or choose another folder."

/** Result of `paper.get`, `paper.link` and `paper.addOverleaf`. */
export interface PaperState {
  paper: PaperView | null
  /** Id of the hidden paper workspace, for files.* and pdf.* calls. */
  workspaceId: string | null
  /**
   * Main .tex file relative to the paper folder (the saved choice, else the
   * guess), or null when it cannot be chosen.
   */
  rootRelPath: string | null
  /** The main .tex file the user chose, or null when PI Lab guesses it. */
  mainDoc: string | null
  /** The paper's .tex files relative to it, sorted, for choosing the main one. */
  texFiles: string[]
  /** False after the user cleared the paper folder: the LaTeX Editor then does not look for Overleaf clones. */
  autoDetect: boolean
  /** Subfolders of the paper folder that could not be read and were skipped. */
  skippedFolders: string[]
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

/**
 * Current paper state for a project. A saved paper folder that no longer
 * exists is reported with `missing: true` (and no root .tex), so the LaTeX
 * Editor can ask for another folder instead of failing.
 */
async function paperState(db: PiLabDatabase, projectId: string): Promise<PaperState> {
  const project = requireProject(db, projectId)
  const paper = project.metadata?.paper
  const autoDetect = project.metadata?.paperAutoDetect !== false
  if (!paper) {
    return {
      paper: null,
      workspaceId: null,
      rootRelPath: null,
      mainDoc: null,
      texFiles: [],
      autoDetect,
      skippedFolders: [],
    }
  }
  const missing = !existsSync(paper.dir)
  const listed = missing ? { files: [], unreadable: [] } : await listPaperFiles(paper.dir)
  return {
    autoDetect,
    skippedFolders: listed.unreadable,
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
      missing,
    },
    workspaceId: paperWorkspace(db, projectId)?.id ?? null,
    rootRelPath: missing ? null : await mainDocOf(paper, listed.files),
    mainDoc: paper.mainDoc ?? null,
    texFiles: listed.files.filter((file) => file.kind === "tex").map((file) => file.relPath),
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
  const isPaper = await isPaperFolder(canonical)
  const search = isPaper ? { papers: [], stoppedEarly: false } : await findPapersInside(canonical)
  return {
    displayDir: await displayDirFor(project, canonical),
    projectFolder: canonical === (await realpath(project.repoPath)),
    overleaf: await isOverleafClone(canonical),
    remoteUrl: origin === null ? null : displayRemoteUrl(origin),
    isPaper,
    inside: search.papers,
    stoppedEarly: search.stoppedEarly,
  }
}

/**
 * Link an existing folder as the project's paper folder, replacing any earlier
 * link. The folder must exist and be a directory, and it must be able to be a
 * paper (a .tex file at its top level, or an Overleaf clone). A folder that
 * contains the project folder is refused. The project folder itself is accepted when it is
 * an Overleaf clone; otherwise `rootChoice` must say whether Sync is on for it
 * (Sync would commit and push the whole project): "sync" needs a Git remote,
 * and "no-sync" stores Sync as off. When the folder is the top of its own Git
 * repository, its `origin` URL is recorded without any embedded credentials,
 * and (unless Sync is off) the build output folder is added to that repo's
 * local `.git/info/exclude` so PDF build output is never committed. The previous link's output folder override and main
 * .tex choice are kept when the same folder is linked again.
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
  if (!(await isPaperFolder(canonical))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: NOT_A_PAPER })
  }
  const ownRepo = await isOwnRepo(canonical)
  const origin = ownRepo ? await remoteUrl(canonical) : null
  // A paper-only project's folder is the paper, so Sync never reaches other files.
  const askRoot =
    isProjectFolder && !project.metadata?.paperOnly && !(await isOverleafClone(canonical))
  if (askRoot && rootChoice === null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: ROOT_CHOICE_REQUIRED })
  }
  if (askRoot && rootChoice === "sync" && origin === null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: ROOT_SYNC_NO_REMOTE })
  }
  const syncOff = askRoot && rootChoice === "no-sync"
  const previous = project.metadata?.paper
  const outputDir = previous?.dir === canonical ? previous.outputDir : undefined
  const mainDoc = previous?.dir === canonical ? previous.mainDoc : undefined
  const paper: ProjectPaper = { dir: canonical, remoteUrl: null, lastSyncAt: null }
  if (outputDir !== undefined) paper.outputDir = outputDir
  if (mainDoc !== undefined) paper.mainDoc = mainDoc
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
 * The folder an Overleaf clone for `project` goes into: `<project>/paper` when
 * `dir` is null, else `dir` ("~" is the home folder). Refuses (CONFLICT) when
 * `<project>/paper` already exists, or when `dir` is a folder with files in it.
 */
async function requireCloneTarget(project: Project, dir: string | null): Promise<string> {
  if (dir === null) {
    const target = join(project.repoPath, "paper")
    if (existsSync(target)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `${target} already exists. Use the existing folder or move it first.`,
      })
    }
    return target
  }
  const target = expandHome(dir)
  if (!(await isFreeFolder(target))) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Choose an empty folder for the paper: ${target} has files in it.`,
    })
  }
  return target
}

/**
 * Clone `url` into `<project>/paper` (`dir` null) or into the chosen folder
 * `dir` (missing parent folders are made), then link it. A clone inside the
 * project folder is hidden from the project's own Git repo (via
 * `.git/info/exclude`) when the project is a Git repo; a clone outside it is
 * linked the same way as a paper folder outside the project. Refuses when the
 * target is taken (see {@link requireCloneTarget}).
 */
export async function clonePaper(
  db: PiLabDatabase,
  projectId: string,
  url: string,
  dir: string | null,
  options: RemoteCallOptions,
): Promise<PaperState> {
  const project = requireProject(db, projectId)
  const target = await requireCloneTarget(project, dir)
  await mkdir(dirname(target), { recursive: true })
  await clone(dirname(target), url, target, options)
  const inside = containsOrEquals(await realpath(project.repoPath), await realpath(target))
  if (inside && (await isGitRepo(project.repoPath))) {
    await excludeFromProjectRepo(project.repoPath, target)
  }
  return linkPaper(db, projectId, target, null)
}

/** True when `dir` holds nothing but a `.DS_Store` file. */
async function isEmptyFolder(dir: string): Promise<boolean> {
  return (await readdir(dir)).every((name) => name === ".DS_Store")
}

/**
 * True when a new paper can be made in `dir`: an empty folder, or a missing
 * folder whose parent folder exists.
 */
async function canCreateIn(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return existsSync(dirname(dir))
  return (await stat(dir)).isDirectory() && (await isEmptyFolder(dir))
}

/**
 * Where "Start draft" puts the paper by default: `<project>/paper`, or when
 * that cannot be used (it has files in it), the first of `paper-2`, `paper-3`,
 * … that is missing or empty. See {@link CreateTarget}.
 */
async function createTarget(db: PiLabDatabase, projectId: string): Promise<CreateTarget> {
  const project = requireProject(db, projectId)
  let name = "paper"
  for (let n = 2; !(await canCreateIn(join(project.repoPath, name))); n++) name = `paper-${n}`
  const projectDir = existsSync(project.repoPath)
    ? await realpath(project.repoPath)
    : project.repoPath
  return {
    dir: join(project.repoPath, name),
    displayDir: await displayDirFor(project, join(projectDir, name)),
  }
}

/**
 * Create a new paper in `dir` from the LaTeX template in use (see
 * `paper/template.ts`) and make it the project's paper folder. `dir` must be
 * an empty folder, or a missing folder whose parent exists. The paper gets its
 * own Git repository (`git init`) with the template committed, and, when it
 * is inside the project's Git repo, is hidden from it through
 * `.git/info/exclude`, as an Overleaf clone is. It has no remote until it is
 * connected to Overleaf (see {@link connectRemote}).
 */
export async function createPaper(
  db: PiLabDatabase,
  projectId: string,
  dir: string,
  dataDir: string,
): Promise<PaperState> {
  const project = requireProject(db, projectId)
  if (!(await canCreateIn(dir))) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: existsSync(dir)
        ? `Choose an empty folder for the new paper: ${dir} has files in it.`
        : `Not a folder: ${dirname(dir)}`,
    })
  }
  await requireCommitIdentity()
  const madeFolder = !existsSync(dir)
  if (madeFolder) await mkdir(dir)
  const target = await realpath(dir)
  // A failed step removes the folder made here (never a folder that was there
  // before), so nothing half made is left; the paper is linked only at the end.
  await fillPaper(project, target, dataDir, getSettingsOrDefaults(db).editor.latexOutputDir).then(
    undefined,
    async (error: unknown) => {
      if (madeFolder) await rm(target, { recursive: true, force: true })
      throw error
    },
  )
  return linkPaper(db, projectId, target, null)
}

/** `path` with a leading "~" replaced by the home folder, made absolute. */
function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return resolve(path)
}

/** True when a paper folder can be made at `dir`: it is missing, or an empty folder. */
async function isFreeFolder(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return true
  return (await stat(dir)).isDirectory() && (await isEmptyFolder(dir))
}

/** The last path part of an Overleaf Git URL (the Overleaf project id), or null. */
function overleafProjectId(url: string): string | null {
  const id = url.trim().replace(/\/+$/, "").split("/").pop() ?? ""
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null
}

/**
 * The folder for a new paper inside `root`: `<root>/<Overleaf project id of url>`,
 * or `paper`, `paper-2`, … (the first free one) when `url` is null or has no id.
 */
async function paperTargetIn(root: string, url: string | null): Promise<{ dir: string }> {
  const id = url === null ? null : overleafProjectId(url)
  if (id !== null) return { dir: join(root, id) }
  let name = "paper"
  for (let n = 2; !(await isFreeFolder(join(root, name))); n++) name = `paper-${n}`
  return { dir: join(root, name) }
}

/**
 * Where a paper added with no project goes by default: `<papers folder>/<name>`
 * (the papers folder from Settings); see {@link paperTargetIn}.
 */
function standaloneTarget(db: PiLabDatabase, url: string | null): Promise<{ dir: string }> {
  return paperTargetIn(expandHome(getSettingsOrDefaults(db).editor.papersFolder), url)
}

/** How a paper with no project is added; see {@link addStandalonePaper}. */
export type StandaloneSource =
  | { source: "folder"; dir: string }
  | { source: "draft"; dir: string }
  | { source: "overleaf"; dir: string; url: string; token?: string }

/** Remove the project row `projectId` (used to undo a paper-only project that could not be set up). */
function dropProject(db: PiLabDatabase, projectId: string): void {
  db.delete(projects).where(eq(projects.id, projectId)).run()
}

/**
 * Add a paper with no project as a paper-only project (see
 * `addPaperOnlyProject`) whose paper folder is its own folder: an existing
 * paper folder, a new draft from the LaTeX template, or a clone of an
 * Overleaf project. A draft or clone goes into `dir`, which must be missing
 * or empty; missing parent folders are made. When a step fails, the project
 * row (and a folder made here) is removed again.
 */
async function addStandalonePaper(
  ctx: AppContext,
  input: StandaloneSource,
): Promise<{ projectId: string }> {
  if (input.source === "folder") {
    const canonical = await requireFolder(input.dir)
    if (!(await isPaperFolder(canonical))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: NOT_A_PAPER })
    }
    const project = await addPaperOnlyProject(ctx, canonical)
    await linkPaper(ctx.db, project.id, canonical, null).then(undefined, (error: unknown) => {
      dropProject(ctx.db, project.id)
      throw error
    })
    return { projectId: project.id }
  }
  const dir = expandHome(input.dir)
  if (!(await isFreeFolder(dir))) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Choose an empty folder for the new paper: ${dir} has files in it.`,
    })
  }
  if (input.source === "overleaf") {
    requireOverleafUrl(input.url)
    await mkdir(dirname(dir), { recursive: true })
    await withOverleafAuth(ctx, input.url, input.token, (options) =>
      clone(dirname(dir), input.url, dir, options),
    )
    const project = await addPaperOnlyProject(ctx, dir)
    await linkPaper(ctx.db, project.id, dir, null).then(undefined, (error: unknown) => {
      dropProject(ctx.db, project.id)
      throw error
    })
    return { projectId: project.id }
  }
  await requireCommitIdentity()
  const madeFolder = !existsSync(dir)
  await mkdir(dir, { recursive: true })
  const project = await addPaperOnlyProject(ctx, dir)
  await createPaper(ctx.db, project.id, dir, resolveDataDir()).then(
    undefined,
    async (error: unknown) => {
      dropProject(ctx.db, project.id)
      if (madeFolder) await rm(dir, { recursive: true, force: true })
      throw error
    },
  )
  return { projectId: project.id }
}

/**
 * Link the paper of the paper-only project `fromProjectId` to the project
 * `toProjectId` (which must have no paper folder), keeping its build output
 * folder, Sync choice and last sync time, then remove the paper-only project.
 * Its files are never touched. When the removal is refused (its agents are
 * still running), the link to `toProjectId` is undone.
 */
async function movePaperToProject(
  ctx: AppContext,
  fromProjectId: string,
  toProjectId: string,
): Promise<PaperState> {
  const from = requireProject(ctx.db, fromProjectId)
  if (!from.metadata?.paperOnly) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Only a paper added with no project can be linked to a project.",
    })
  }
  const paper = requirePaper(from)
  const to = requireProject(ctx.db, toProjectId)
  if (to.metadata?.paper) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `"${to.name}" already has a paper folder. Clear it in the LaTeX Editor first.`,
    })
  }
  await linkPaper(ctx.db, toProjectId, paper.dir, null)
  changePaper(ctx.db, toProjectId, (current) => {
    const next: ProjectPaper = { ...current, lastSyncAt: paper.lastSyncAt }
    if (paper.outputDir !== undefined) next.outputDir = paper.outputDir
    if (paper.syncEnabled !== undefined) next.syncEnabled = paper.syncEnabled
    return next
  })
  await projectsRouter
    .createCaller(ctx)
    .remove({ id: fromProjectId })
    .then(undefined, (error: unknown) => {
      ctx.db
        .delete(workspaces)
        .where(and(eq(workspaces.projectId, toProjectId), eq(workspaces.kind, "paper")))
        .run()
      writePaper(ctx.db, toProjectId, null)
      throw error
    })
  return paperState(ctx.db, toProjectId)
}

/** Error message when Git has no name and email to commit with. */
const COMMIT_IDENTITY_REQUIRED =
  'Set your Git name and email first: git config --global user.name "Your Name" and git config --global user.email "you@example.com"'

/**
 * Throw PRECONDITION_FAILED when Git cannot commit for lack of a name and
 * email. `git var` checks them as `git commit` does; GIT_DIR points at no
 * repository, so only the settings a new repository would get are read.
 */
async function requireCommitIdentity(): Promise<void> {
  for (const ident of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    const result = await runGit(homedir(), ["var", ident], {
      allowFailure: true,
      env: { GIT_DIR: "/dev/null" },
    })
    if (result.stdout.trim() === "") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: COMMIT_IDENTITY_REQUIRED })
    }
  }
}

/**
 * The steps of {@link createPaper} before linking: copy the template into
 * `target`, `git init`, hide it from the project repo, exclude the build output
 * folder (so the commit never holds build output), and commit.
 */
async function fillPaper(
  project: Project,
  target: string,
  dataDir: string,
  defaultOutputDir: string,
): Promise<void> {
  await writeTemplate(dataDir, target)
  await runGit(target, ["init"], {})
  if (await isGitRepo(project.repoPath)) {
    const projectRoot = await realpath(await repoRoot(project.repoPath))
    if (containsOrEquals(projectRoot, dirname(target))) {
      await excludeFromProjectRepo(project.repoPath, target)
    }
  }
  await excludeEffectiveOutputs(
    { dir: target, remoteUrl: null, lastSyncAt: null },
    defaultOutputDir,
  )
  await commitAll(target, CREATE_COMMIT_MESSAGE)
}

/**
 * Connect a paper folder with no remote to `url`, a Blank Overleaf project
 * (Overleaf has no API to create projects, so the user creates it on
 * overleaf.com). Edits not committed yet are committed first. The project's
 * branch is merged in although the histories are unrelated, keeping exactly
 * the local files (Overleaf's default files are dropped), and the local branch
 * takes the project's branch name, because Overleaf has only one branch. Then
 * `origin` is set to `url` and the result is pushed; if the push fails,
 * `origin` is removed again and the paper stays unconnected.
 */
export async function connectRemote(
  db: PiLabDatabase,
  projectId: string,
  url: string,
  options: RemoteCallOptions,
): Promise<SyncResult> {
  const paper = requirePaper(requireProject(db, projectId))
  requireSyncEnabled(paper.syncEnabled)
  const dir = paper.dir
  if (!(await isOwnRepo(dir))) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `The paper folder is not its own Git repository, so it cannot be connected to Overleaf: ${dir}`,
    })
  }
  if ((await remoteUrl(dir)) !== null) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This paper folder already has a Git remote. Use Sync instead.",
    })
  }
  if ((await status(dir)).length > 0) await commitAll(dir, SYNC_COMMIT_MESSAGE)
  const branch = await remoteDefaultBranch(dir, url, options)
  if (branch !== null) {
    await mergeUnrelatedKeepingOurs(dir, url, branch, CONNECT_COMMIT_MESSAGE, options)
    await runGit(dir, ["branch", "-M", branch], {})
  }
  await runGit(dir, ["remote", "add", "origin", url], {})
  // A failed push removes `origin` again, so the paper stays unconnected and Connect can be retried.
  await pushSetUpstream(dir, branch ?? (await currentBranch(dir)), options).then(
    undefined,
    async (error: unknown) => {
      await runGit(dir, ["remote", "remove", "origin"], {})
      throw error
    },
  )
  changePaper(db, projectId, (current) => ({ ...current, remoteUrl: displayRemoteUrl(url) }))
  return markSynced(db, projectId)
}

/** Throw BAD_REQUEST when `url` cannot be used as an Overleaf Git URL; see {@link overleafUrlProblem}. */
function requireOverleafUrl(url: string): void {
  const problem = overleafUrlProblem(url)
  if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem })
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
  return tokenAuth(readToken(ctx))
}

/** Auth with `token` when given (askpass script), else the user's Git credential, else null. */
async function tokenAuth(token: string | null): Promise<OverleafAuth> {
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

/**
 * Change the project's saved paper link with `change`, applied to the link as
 * it is stored now. Callers that awaited (network or git calls) since they
 * read the link use this, so a change saved meanwhile (an output folder, a
 * sync time) is kept. Throws PRECONDITION_FAILED when no paper is linked.
 */
function changePaper(
  db: PiLabDatabase,
  projectId: string,
  change: (paper: ProjectPaper) => ProjectPaper,
): void {
  writePaper(db, projectId, change(requirePaper(requireProject(db, projectId))))
}

/** Record a successful sync and return the synced result. */
function markSynced(db: PiLabDatabase, projectId: string): SyncResult {
  const lastSyncAt = Date.now()
  changePaper(db, projectId, (current) => ({ ...current, lastSyncAt }))
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

/** One conflicted file of the paper's merge and its kind (from `paper.conflicts`). */
export interface PaperConflict {
  /** Path relative to the paper folder. */
  relPath: string
  kind: ConflictKind
}

/** The paper folder of a merge in progress, or PRECONDITION_FAILED when there is none. */
async function mergingDir(db: PiLabDatabase, projectId: string): Promise<string> {
  const target = await syncTarget(db, projectId)
  if (!target || !(await isMerging(target.dir))) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No merge is in progress" })
  }
  return target.dir
}

/**
 * Settle one conflicted file with "mine" or "overleaf" (deleting it when that
 * side deleted it), as `paper.resolve` does for every file. The merge stays
 * open: Sync finishes it once no conflict is left.
 */
async function resolvePaperFile(
  db: PiLabDatabase,
  projectId: string,
  relPath: string,
  choice: "mine" | "overleaf",
): Promise<PaperConflict[]> {
  const dir = await mergingDir(db, projectId)
  const sides = (await conflictStages(dir)).get(relPath)
  if (!sides) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${relPath} is not in conflict` })
  }
  await takeSideOf(dir, choice === "mine" ? "ours" : "theirs", relPath, sides)
  return conflictKinds(dir)
}

/** Save (or replace) the Overleaf Git token, encrypted with the OS keychain. */
function saveToken(ctx: AppContext, token: string): void {
  const encryptedValue = ctx.credentialCipher.encrypt(token)
  const updatedAt = Date.now()
  ctx.db
    .insert(serviceCredentials)
    .values({ service: OVERLEAF_SERVICE, encryptedValue, updatedAt })
    .onConflictDoUpdate({
      target: serviceCredentials.service,
      set: { encryptedValue, updatedAt },
    })
    .run()
}

/** A new Overleaf Git token, as typed by the user. */
const tokenInput = z.string().trim().min(1).max(4096)

/**
 * Run an Overleaf call to `url` (`run` gets its Git env). With `token` (typed
 * by the user for this attempt) the call uses it, and it is saved only when the
 * call succeeds, so a wrong token is never kept. Without one, the saved token
 * or the user's Git credential is used, and PRECONDITION_FAILED
 * "overleaf-token-required" is thrown when there is neither.
 */
async function withOverleafAuth<T>(
  ctx: AppContext,
  url: string,
  token: string | undefined,
  run: (options: RemoteCallOptions) => Promise<T>,
): Promise<T> {
  if (token === undefined) {
    if (!(await tokenStatus(ctx.db)).configured) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: OVERLEAF_TOKEN_REQUIRED })
    }
    return run(await remoteOptions(ctx, [url]))
  }
  const result = await run({ env: remoteEnv([url], await tokenAuth(token)) })
  saveToken(ctx, token)
  return result
}

const tokenRouter = router({
  /**
   * Whether an Overleaf credential is available and where it comes from (a
   * saved token wins over the user's Git). The secret itself is never returned.
   */
  status: publicProcedure.query(({ ctx }): Promise<OverleafTokenStatus> => tokenStatus(ctx.db)),

  /** Save (or replace) the Overleaf Git token, encrypted with the OS keychain. */
  set: publicProcedure
    .input(z.object({ token: tokenInput }))
    .mutation(({ ctx, input }): OverleafTokenStatus => {
      saveToken(ctx, input.token)
      return { configured: true, source: "saved" }
    }),

  /** Delete the saved Overleaf token and return the status after it (Git may still have one). */
  clear: publicProcedure.mutation(({ ctx }): Promise<OverleafTokenStatus> => {
    ctx.db.delete(serviceCredentials).where(eq(serviceCredentials.service, OVERLEAF_SERVICE)).run()
    return tokenStatus(ctx.db)
  }),
})

const templateRouter = router({
  /** Which LaTeX template "Start draft" uses: the built-in one or the user's. */
  status: publicProcedure.query((): Promise<TemplateStatus> => templateStatus(resolveDataDir())),

  /** Use the user's folder as the LaTeX template from now on (its files are copied). */
  set: publicProcedure
    .input(z.object({ dir: z.string().min(1) }))
    .mutation(
      ({ input }): Promise<TemplateStatus> => setCustomTemplate(resolveDataDir(), input.dir),
    ),

  /** Go back to the built-in LaTeX template. */
  clear: publicProcedure.mutation(
    (): Promise<TemplateStatus> => clearCustomTemplate(resolveDataDir()),
  ),
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
      const root = await mainDocOf(paper, null)
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

  /**
   * What linking a folder would mean (project folder, Overleaf clone, remote
   * URL), whether it can be a paper, and if not, the papers found inside it.
   */
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
   * Clone an Overleaf project into `<project>/paper` (`dir` null) or a chosen
   * folder `dir`, then link it; see {@link clonePaper}. Uses the token typed
   * for this attempt (saved once the clone works), else the saved token or the
   * user's Git credential; see {@link withOverleafAuth}.
   */
  addOverleaf: publicProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        url: z.string().trim().min(1),
        dir: z.string().trim().min(1).nullable(),
        token: tokenInput.optional(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<PaperState> => {
      requireOverleafUrl(input.url)
      // A taken target is refused before any token is asked for.
      await requireCloneTarget(requireProject(ctx.db, input.projectId), input.dir)
      return withOverleafAuth(ctx, input.url, input.token, (options) =>
        clonePaper(ctx.db, input.projectId, input.url, input.dir, options),
      )
    }),

  /**
   * Where an Overleaf clone goes when the remembered clone location is the
   * folder `folder`: `<folder>/<Overleaf project id>`; see {@link paperTargetIn}.
   */
  cloneTarget: publicProcedure
    .input(z.object({ folder: z.string().trim().min(1), url: z.string().trim().min(1) }))
    .query(
      ({ input }): Promise<{ dir: string }> => paperTargetIn(expandHome(input.folder), input.url),
    ),

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
      // Only the output folder changes: a sync saved during the awaits is kept.
      changePaper(ctx.db, input.projectId, (current) => {
        const { outputDir: _current, ...others } = current
        return next.outputDir === undefined ? others : { ...others, outputDir: next.outputDir }
      })
      return paperState(ctx.db, input.projectId)
    }),

  /**
   * Set this paper's main .tex file (a listed .tex file, relative to the paper
   * folder), or clear it with "" so PI Lab guesses it. It is also the build root
   * of a saved .tex with no `\documentclass` or `% !TeX root` of its own. The
   * build output of the new main .tex is excluded like {@link setOutputDir} does.
   */
  setMainDoc: publicProcedure
    .input(z.object({ projectId: z.string().min(1), mainDoc: z.string().max(1024) }))
    .mutation(async ({ ctx, input }): Promise<PaperState> => {
      const paper = requirePaper(requireProject(ctx.db, input.projectId))
      const { mainDoc: _old, ...rest } = paper
      const mainDoc = input.mainDoc.trim()
      if (mainDoc !== "") {
        const listed = (await listPaperFiles(paper.dir)).files
        if (!listed.some((file) => file.kind === "tex" && file.relPath === mainDoc)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${mainDoc} is not a .tex file in the paper folder`,
          })
        }
      }
      const next: ProjectPaper = mainDoc === "" ? rest : { ...rest, mainDoc }
      await excludeEffectiveOutputs(next, getSettingsOrDefaults(ctx.db).editor.latexOutputDir)
      // Only the main .tex changes: a sync saved during the awaits is kept.
      changePaper(ctx.db, input.projectId, (current) => {
        const { mainDoc: _current, ...others } = current
        return next.mainDoc === undefined ? others : { ...others, mainDoc: next.mainDoc }
      })
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

  template: templateRouter,

  /** Where "Start draft" puts the paper unless the user chooses another folder. */
  createTarget: publicProcedure
    .input(projectIdInput)
    .query(({ ctx, input }): Promise<CreateTarget> => createTarget(ctx.db, input.projectId)),

  /**
   * Where a paper added with no project goes by default; `url` is the
   * Overleaf Git URL for Add Overleaf project, or null for Start draft.
   */
  standaloneTarget: publicProcedure
    .input(z.object({ url: z.string().nullable() }))
    .query(({ ctx, input }): Promise<{ dir: string }> => standaloneTarget(ctx.db, input.url)),

  /** Add a paper with no project as a paper-only project; see {@link addStandalonePaper}. */
  addStandalone: publicProcedure
    .input(
      z.discriminatedUnion("source", [
        z.object({ source: z.literal("folder"), dir: z.string().min(1) }),
        z.object({ source: z.literal("draft"), dir: z.string().min(1) }),
        z.object({
          source: z.literal("overleaf"),
          dir: z.string().min(1),
          url: z.string().trim().min(1),
          token: tokenInput.optional(),
        }),
      ]),
    )
    .mutation(({ ctx, input }): Promise<{ projectId: string }> => addStandalonePaper(ctx, input)),

  /** Link a paper-only project's paper to a project; see {@link movePaperToProject}. */
  moveToProject: publicProcedure
    .input(z.object({ fromProjectId: z.string().min(1), toProjectId: z.string().min(1) }))
    .mutation(
      ({ ctx, input }): Promise<PaperState> =>
        movePaperToProject(ctx, input.fromProjectId, input.toProjectId),
    ),

  /** Whether "Start draft" can use a folder the user chose; see {@link canCreateIn}. */
  canCreateIn: publicProcedure
    .input(z.object({ dir: z.string().min(1) }))
    .query(({ input }): Promise<boolean> => canCreateIn(input.dir)),

  /** The Update paper button: start an agent with the write-research skill; see {@link startUpdatePaper}. */
  startUpdate: publicProcedure
    .input(projectIdInput)
    .mutation(
      ({ ctx, input }): Promise<StartUpdatePaperResult> => startUpdatePaper(ctx, input.projectId),
    ),

  /** Create a new paper from the LaTeX template; see {@link createPaper}. */
  create: publicProcedure
    .input(z.object({ projectId: z.string().min(1), dir: z.string().min(1) }))
    .mutation(
      ({ ctx, input }): Promise<PaperState> =>
        createPaper(ctx.db, input.projectId, input.dir, resolveDataDir()),
    ),

  /**
   * Connect a paper with no remote to a Blank Overleaf project's Git URL (see
   * {@link connectRemote}), with the token typed for this attempt (saved once
   * the connect works), else the saved token or the user's Git credential.
   */
  connectOverleaf: publicProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        url: z.string().trim().min(1),
        token: tokenInput.optional(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<SyncResult> => {
      requireOverleafUrl(input.url)
      const paper = requirePaper(requireProject(ctx.db, input.projectId))
      if ((await isOwnRepo(paper.dir)) && (await remoteUrl(paper.dir)) !== null) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This paper folder already has a Git remote. Use Sync instead.",
        })
      }
      return withOverleafAuth(ctx, input.url, input.token, (options) =>
        connectRemote(ctx.db, input.projectId, input.url, options),
      )
    }),

  /** Pull and push the paper folder; see {@link syncPaper}. */
  sync: publicProcedure
    .input(z.object({ projectId: z.string().min(1), commit: z.boolean() }))
    .mutation(
      ({ ctx, input }): Promise<SyncResult> => syncPaper(ctx, input.projectId, input.commit),
    ),

  /**
   * The conflicted files of the paper's merge with their kind, so only text
   * files go to the agent and the others get a per-file choice.
   */
  conflicts: publicProcedure
    .input(projectIdInput)
    .query(
      async ({ ctx, input }): Promise<PaperConflict[]> =>
        conflictKinds(await mergingDir(ctx.db, input.projectId)),
    ),

  /** Settle one conflicted file; see {@link resolvePaperFile}. Returns the conflicts left. */
  resolveFile: publicProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        relPath: z.string().min(1),
        choice: z.enum(["mine", "overleaf"]),
      }),
    )
    .mutation(
      ({ ctx, input }): Promise<PaperConflict[]> =>
        resolvePaperFile(ctx.db, input.projectId, input.relPath, input.choice),
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
