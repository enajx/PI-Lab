import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import {
  type PiLabDatabase,
  type Project,
  type ProjectAgentConfig,
  type ProjectConfigStorage,
  projects,
} from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"

const CONFIG_RELATIVE_PATH = [".pi-lab", "config.json"] as const

async function assertSafeConfigLocation(project: Project, createParent: boolean): Promise<string> {
  const repo = await realpath(project.repoPath)
  const parent = join(repo, CONFIG_RELATIVE_PATH[0])
  const info = await lstat(parent).then(
    (value) => value,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    },
  )
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${parent} must be a real directory inside the project`,
    })
  }
  if (!info && createParent) await mkdir(parent)
  if (!info && !createParent) return join(parent, CONFIG_RELATIVE_PATH[1])

  const realParent = await realpath(parent)
  const rel = relative(resolve(repo), resolve(realParent))
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new TRPCError({ code: "FORBIDDEN", message: `${parent} escapes the project` })
  }
  const path = join(realParent, CONFIG_RELATIVE_PATH[1])
  const fileInfo = await lstat(path).then(
    (value) => value,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    },
  )
  if (fileInfo?.isSymbolicLink() || (fileInfo && !fileInfo.isFile())) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${path} must be a regular file`,
    })
  }
  return path
}

function parseConfig(raw: string, path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${path} must contain a JSON object` })
  }
  return parsed as Record<string, unknown>
}

async function readRepoConfig(project: Project): Promise<Record<string, unknown> | null> {
  const path = await assertSafeConfigLocation(project, false)
  const raw = await readFile(path, "utf8").then(
    (value) => value,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    },
  )
  return raw === null ? null : parseConfig(raw, path)
}

async function writeRepoConfig(project: Project, config: ProjectAgentConfig): Promise<void> {
  const existing = (await readRepoConfig(project)) ?? {}
  const next = { ...existing, ...config }
  const path = await assertSafeConfigLocation(project, true)
  const temp = join(dirname(path), `.config.${randomUUID()}.tmp`)
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" })
  await rename(temp, path)
}

function appConfig(project: Project): ProjectAgentConfig {
  return project.agentConfig ?? {}
}

export async function readProjectAgentConfig(
  project: Project,
  storage: ProjectConfigStorage,
): Promise<ProjectAgentConfig> {
  if (storage === "app") return appConfig(project)
  const repo = await readRepoConfig(project)
  if (storage === "project")
    return { agentId: typeof repo?.agentId === "string" ? repo.agentId : undefined }
  // In "both", the repository copy is authoritative whenever it exists.
  if (repo) {
    return { agentId: typeof repo.agentId === "string" ? repo.agentId : undefined }
  }
  return appConfig(project)
}

export async function writeProjectAgentConfig(
  db: PiLabDatabase,
  project: Project,
  storage: ProjectConfigStorage,
  config: ProjectAgentConfig,
): Promise<void> {
  if (storage === "project" || storage === "both") await writeRepoConfig(project, config)
  if (storage === "app" || storage === "both") {
    db.update(projects)
      .set({ agentConfig: { ...appConfig(project), ...config }, updatedAt: Date.now() })
      .where(eq(projects.id, project.id))
      .run()
  }
}
