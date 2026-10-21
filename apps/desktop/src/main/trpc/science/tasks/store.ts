import { randomUUID } from "node:crypto"
import type { Dirent } from "node:fs"
import { readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Project } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import {
  type ParsedTask,
  type ParsedTaskDocument,
  parseTaskDocument,
  renderNewTask,
  renderUpdatedTask,
  selectTask,
  type TaskFields,
  taskRevision,
} from "./markdown"
import type { ScienceTask, TaskListing, TaskSelector, TaskSource, TaskStatus } from "./model"

const TODO_MARKDOWN_NAME = /todo.*\.md$/i
const CANONICAL_NAMES = new Set(["todo.md", "todos.md"])

export interface DiscoveredTaskFile {
  state: TaskSource["state"]
  relPath: string | null
  candidates: string[]
  error?: string
}

/** Discover a project's human-owned root TODO Markdown document. */
export async function discoverTaskFile(repoPath: string): Promise<DiscoveredTaskFile> {
  let entries: Dirent[]
  try {
    entries = await readdir(repoPath, { withFileTypes: true })
  } catch (error) {
    return { state: "error", relPath: null, candidates: [], error: errorMessage(error) }
  }

  const candidates = entries
    .filter((entry) => entry.isFile() && TODO_MARKDOWN_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
  if (candidates.length === 0) return { state: "missing", relPath: null, candidates }

  const canonical = candidates.filter((name) => CANONICAL_NAMES.has(name.toLowerCase()))
  if (canonical.length === 1) {
    const relPath = canonical[0]
    if (!relPath) throw new Error("Canonical TODO candidate is missing")
    return { state: "ready", relPath, candidates }
  }
  if (canonical.length > 1 || candidates.length > 1) {
    return { state: "ambiguous", relPath: null, candidates }
  }
  const relPath = candidates[0]
  if (!relPath) throw new Error("TODO candidate is missing")
  return { state: "ready", relPath, candidates }
}

/** Aggregate each project's selected or discovered Markdown task source. */
export async function listProjectTasks(projectRows: Project[]): Promise<TaskListing> {
  const sources: TaskSource[] = []
  const tasks: ScienceTask[] = []

  for (const project of [...projectRows].sort((a, b) => a.name.localeCompare(b.name))) {
    const discovered = project.taskRelPath
      ? { state: "ready" as const, relPath: project.taskRelPath, candidates: [project.taskRelPath] }
      : await discoverTaskFile(project.repoPath)
    if (discovered.state !== "ready" || !discovered.relPath) {
      sources.push({
        projectId: project.id,
        projectName: project.name,
        state: discovered.state,
        relPath: discovered.relPath,
        candidates: discovered.candidates,
        revision: null,
        headings: [],
        boardHeadings: [],
        ...(discovered.error ? { error: discovered.error } : {}),
      })
      continue
    }

    try {
      await validateTaskRelPath(project, discovered.relPath)
      const content = await readFile(join(project.repoPath, discovered.relPath), "utf8")
      const document = parseTaskDocument(content, project, discovered.relPath)
      sources.push({
        projectId: project.id,
        projectName: project.name,
        state: "ready",
        relPath: discovered.relPath,
        candidates: discovered.candidates,
        revision: document.revision,
        headings: document.headings.map((heading) => ({
          key: heading.key,
          label: heading.label,
          path: heading.path,
        })),
        boardHeadings: document.boardHeadings,
      })
      tasks.push(...document.tasks.map(toPublicTask))
    } catch (error) {
      sources.push({
        projectId: project.id,
        projectName: project.name,
        state: "error",
        relPath: discovered.relPath,
        candidates: discovered.candidates,
        revision: null,
        headings: [],
        boardHeadings: [],
        error: errorMessage(error),
      })
    }
  }

  return { sources, tasks }
}

export interface MutationFile {
  project: Project
  relPath: string
  expectedRevision: string
}

export interface CreateTaskInput {
  project: Project
  relPath: string
  expectedRevision: string | null
  fields: TaskFields
  headingKey?: string
}

/** Create a task at the end of a document or heading section. */
export async function createTask(input: CreateTaskInput): Promise<{
  task: ScienceTask
  revision: string
}> {
  await validateTaskRelPath(input.project, input.relPath)
  const path = join(input.project.repoPath, input.relPath)
  const current = await readOptionalFile(path)
  assertRevision(current === null ? null : taskRevision(current), input.expectedRevision)
  const content = current ?? ""
  const document = parseTaskDocument(content, input.project, input.relPath)
  const rendered = renderNewTask(input.fields, document.newline)
  const insertion = resolveInsertion(document, input.headingKey)
  const next = insertBlock(content, insertion, rendered.block, document.newline)
  await atomicWrite(path, next, input.expectedRevision)
  const parsed = parseTaskDocument(next, input.project, input.relPath)
  const task = parsed.tasks.find((candidate) => candidate.id === rendered.id)
  if (!task) throw new Error("Created task could not be read back")
  return { task: toPublicTask(task), revision: parsed.revision }
}

export interface UpdateTaskInput extends MutationFile {
  selector: TaskSelector
  patch: Partial<TaskFields>
}

/** Update one exact task block and preserve all unrelated source bytes. */
export async function updateTask(input: UpdateTaskInput): Promise<{
  task: ScienceTask
  revision: string
}> {
  const { document, task, path } = await loadMutationTarget(input)
  const fields = mergeFields(task, input.patch)
  const rendered = renderUpdatedTask(task, fields, document.newline)
  const next = replaceRange(document.content, task.source.start, task.source.end, rendered.block)
  await atomicWrite(path, next, input.expectedRevision)
  return readBackTask(next, input.project, input.relPath, rendered.id)
}

export interface DeleteTaskInput extends MutationFile {
  selector: TaskSelector
}

/** Delete one task block, leaving the rest of the human-authored file untouched. */
export async function deleteTask(input: DeleteTaskInput): Promise<{ revision: string }> {
  const { document, task, path } = await loadMutationTarget(input)
  const next = replaceRange(document.content, task.source.start, task.source.end, "")
  await atomicWrite(path, next, input.expectedRevision)
  return { revision: taskRevision(next) }
}

export type MoveTaskInput = MutationFile & {
  selector: TaskSelector
  destination: { mode: "status"; status: TaskStatus } | { mode: "heading"; headingKey: string }
}

/** Move a task by status metadata or by relocating its complete Markdown block. */
export async function moveTask(input: MoveTaskInput): Promise<{
  task: ScienceTask
  revision: string
}> {
  const { document, task, path } = await loadMutationTarget(input)
  if (input.destination.mode === "status") {
    const rendered = renderUpdatedTask(
      task,
      mergeFields(task, { status: input.destination.status }),
      document.newline,
    )
    const next = replaceRange(document.content, task.source.start, task.source.end, rendered.block)
    await atomicWrite(path, next, input.expectedRevision)
    return readBackTask(next, input.project, input.relPath, rendered.id)
  }

  const headingKey = input.destination.headingKey
  const heading = document.headings.find((candidate) => candidate.key === headingKey)
  if (!heading) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Target heading no longer exists" })
  }
  const rendered = renderUpdatedTask(task, mergeFields(task, {}), document.newline)
  const without = replaceRange(document.content, task.source.start, task.source.end, "")
  const originalInsertion = heading.directContentEnd
  const adjustedInsertion =
    task.source.start < originalInsertion
      ? originalInsertion - (task.source.end - task.source.start)
      : originalInsertion
  const next = insertBlock(without, adjustedInsertion, rendered.block, document.newline)
  await atomicWrite(path, next, input.expectedRevision)
  return readBackTask(next, input.project, input.relPath, rendered.id)
}

function resolveInsertion(document: ParsedTaskDocument, headingKey?: string): number {
  if (!headingKey) return document.content.length
  const heading = document.headings.find((candidate) => candidate.key === headingKey)
  if (!heading) throw new TRPCError({ code: "NOT_FOUND", message: "Target heading not found" })
  return heading.directContentEnd
}

function insertBlock(
  content: string,
  offset: number,
  block: string,
  newline: "\n" | "\r\n",
): string {
  const before = content.slice(0, offset)
  const after = content.slice(offset)
  const prefix =
    before.length > 0 && !before.endsWith("\n") && !before.endsWith("\r") ? newline : ""
  const suffix = after.length > 0 && !block.endsWith("\n") && !block.endsWith("\r") ? newline : ""
  return before + prefix + block + suffix + after
}

function mergeFields(task: ParsedTask, patch: Partial<TaskFields>): TaskFields {
  return {
    title: patch.title ?? task.title,
    details: patch.details ?? task.details,
    status: patch.status ?? task.status,
    priority: patch.priority === undefined ? task.priority : patch.priority,
    labels: patch.labels ?? task.labels,
    owner: patch.owner === undefined ? task.owner : patch.owner,
  }
}

async function loadMutationTarget(input: MutationFile & { selector: TaskSelector }): Promise<{
  document: ParsedTaskDocument
  task: ParsedTask
  path: string
}> {
  await validateTaskRelPath(input.project, input.relPath)
  const path = join(input.project.repoPath, input.relPath)
  const content = await readRequiredFile(path)
  const revision = taskRevision(content)
  assertRevision(revision, input.expectedRevision)
  const document = parseTaskDocument(content, input.project, input.relPath)
  if ("id" in input.selector) {
    const selectedId = input.selector.id
    const matches = document.tasks.filter((task) => task.id === selectedId)
    if (matches.length > 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `Task id ${selectedId} is duplicated in ${input.relPath}`,
      })
    }
  }
  const task = selectTask(document, input.selector)
  if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task no longer exists" })
  return { document, task, path }
}

async function readBackTask(
  content: string,
  project: Project,
  relPath: string,
  id: string,
): Promise<{ task: ScienceTask; revision: string }> {
  const parsed = parseTaskDocument(content, project, relPath)
  const matches = parsed.tasks.filter((task) => task.id === id)
  if (matches.length !== 1) throw new Error("Updated task could not be read back uniquely")
  const task = matches[0]
  if (!task) throw new Error("Updated task is missing")
  return { task: toPublicTask(task), revision: parsed.revision }
}

function toPublicTask(task: ParsedTask): ScienceTask {
  return {
    key: task.key,
    id: task.id,
    projectId: task.projectId,
    projectName: task.projectName,
    relPath: task.relPath,
    revision: task.revision,
    title: task.title,
    details: task.details,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    owner: task.owner,
    heading: task.heading,
    boardHeadingKey: task.boardHeadingKey,
    source: task.source,
  }
}

async function validateTaskRelPath(project: Project, relPath: string): Promise<void> {
  if (project.taskRelPath && project.taskRelPath !== relPath) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This is not the project's selected task source",
    })
  }
  if (!project.taskRelPath) {
    if (basename(relPath) !== relPath || !TODO_MARKDOWN_NAME.test(relPath)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Select this Markdown file as the project's task source first",
      })
    }
    return
  }
  const root = await realpath(project.repoPath)
  const path = resolve(root, relPath)
  const lexical = relative(root, path)
  if (
    isAbsolute(relPath) ||
    lexical === "" ||
    lexical === ".." ||
    lexical.startsWith(`..${sep}`) ||
    isAbsolute(lexical)
  ) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Task file is outside this project" })
  }
  const target = await realpath(path)
  const realRelative = relative(root, target)
  if (
    realRelative === "" ||
    realRelative === ".." ||
    realRelative.startsWith(`..${sep}`) ||
    isAbsolute(realRelative)
  ) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Task file is outside this project" })
  }
}

function assertRevision(actual: string | null, expected: string | null): void {
  if (actual !== expected) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "TODO Markdown changed since it was loaded",
      cause: { expectedRevision: expected, actualRevision: actual },
    })
  }
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

async function readRequiredFile(path: string): Promise<string> {
  const content = await readOptionalFile(path)
  if (content === null) throw new TRPCError({ code: "NOT_FOUND", message: "TODO file not found" })
  return content
}

function replaceRange(content: string, start: number, end: number, replacement: string): string {
  return content.slice(0, start) + replacement + content.slice(end)
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Replace a source atomically so interruption cannot leave a partial Markdown file. */
type BeforeAtomicRevisionCheck = (path: string) => Promise<void>
let beforeAtomicRevisionCheck: BeforeAtomicRevisionCheck | null = null
const taskWrites = new Map<string, Promise<void>>()

/** Test-only seam for an out-of-band edit before the final revision check. */
export function setBeforeTaskRevisionCheckForTest(hook: BeforeAtomicRevisionCheck | null): void {
  beforeAtomicRevisionCheck = hook
}

async function atomicWrite(
  path: string,
  content: string,
  expectedRevision: string | null,
): Promise<void> {
  const canonical = await canonicalTaskPath(path)
  const previous = taskWrites.get(canonical) ?? Promise.resolve()
  const pending = previous.then(() => replaceTaskFile(canonical, content, expectedRevision))
  const settled = pending.then(
    () => {},
    () => {},
  )
  taskWrites.set(canonical, settled)
  try {
    await pending
  } finally {
    if (taskWrites.get(canonical) === settled) taskWrites.delete(canonical)
  }
}

/** Resolve aliases to one write queue, including files that have not been created yet. */
async function canonicalTaskPath(path: string): Promise<string> {
  return realpath(path).catch(async (error: unknown) => {
    if (!isNotFound(error)) throw error
    return join(await realpath(dirname(path)), basename(path))
  })
}

async function replaceTaskFile(
  path: string,
  content: string,
  expectedRevision: string | null,
): Promise<void> {
  const temporaryPath = `${path}.pi-lab-${randomUUID()}.tmp`
  await writeFile(temporaryPath, content, "utf8")
  try {
    if (beforeAtomicRevisionCheck) await beforeAtomicRevisionCheck(path)
    const current = await readOptionalFile(path)
    assertRevision(current === null ? null : taskRevision(current), expectedRevision)
    await rename(temporaryPath, path)
  } catch (error) {
    await removeTemporary(temporaryPath)
    throw error
  }
  await removeTemporary(temporaryPath)
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
}
