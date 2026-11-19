import { spawn } from "node:child_process"
import { createReadStream, createWriteStream } from "node:fs"
import { lstat, mkdir, realpath, rename, rm, stat } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"
import { pipeline } from "node:stream/promises"
import { TRPCError } from "@trpc/server"
import type { AppContext } from "../main/trpc/context"
import { requireWorkspace, resolveInsideDir, revealTarget } from "../main/trpc/files/files"
import { workspaceWorkingDir } from "../main/trpc/workspaces/workspaces"

/**
 * Download and Upload of project files for clients on other machines (like
 * VS Code Remote-SSH). Plain streaming HTTP next to the tRPC socket, so a
 * large transfer never holds up calls. Both need the device token (checked
 * in http.ts before these run).
 */

export const DOWNLOAD_PATH = "/files/download"
export const UPLOAD_PATH = "/files/upload"
/** Response header of a download: "file" (the bytes) or "dir" (a tar archive of the folder's contents). */
export const ENTRY_HEADER = "x-pi-lab-entry"
/** Part of the temp file name an upload writes before the rename. */
export const UPLOAD_TEMP_MARK = ".pi-lab-upload-"

const TRPC_STATUS: Partial<Record<TRPCError["code"], number>> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  BAD_REQUEST: 400,
}

/** HTTP status for a failed path check: a TRPCError's code, or 404 for a missing file. */
function failureStatus(error: unknown): number {
  if (error instanceof TRPCError) return TRPC_STATUS[error.code] ?? 500
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
    return 404
  }
  throw error
}

function reply(out: ServerResponse, status: number, message: string): void {
  out.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `workspaceId` and `relPath` of the query, or null when one is missing. */
function entryQuery(url: URL): { workspaceId: string; relPath: string } | null {
  const workspaceId = url.searchParams.get("workspaceId")
  const relPath = url.searchParams.get("relPath")
  return workspaceId && relPath ? { workspaceId, relPath } : null
}

/**
 * `GET /files/download?workspaceId=&relPath=`: a file streams as is; a folder
 * streams as a tar archive of its contents (`tar -c`). A tar that fails
 * part way ends the response early, so the client sees an incomplete transfer.
 */
export async function handleDownload(
  ctx: AppContext,
  url: URL,
  out: ServerResponse,
): Promise<void> {
  const query = entryQuery(url)
  if (!query) return reply(out, 400, "workspaceId and relPath are required")
  const target = await revealTarget(ctx, query).catch((error: unknown) => {
    reply(out, failureStatus(error), errorMessage(error))
    return null
  })
  if (target === null) return
  const info = await stat(target)
  if (info.isFile()) {
    out.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(info.size),
      [ENTRY_HEADER]: "file",
    })
    await pipeline(createReadStream(target), out)
    return
  }
  if (!info.isDirectory()) return reply(out, 400, `${query.relPath} is not a file or folder`)
  out.writeHead(200, { "content-type": "application/x-tar", [ENTRY_HEADER]: "dir" })
  const tar = spawn("tar", ["-cf", "-", "-C", target, "."], { stdio: ["ignore", "pipe", "pipe"] })
  let stderr = ""
  tar.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exited = new Promise<number | null>((resolve) => tar.once("close", resolve))
  out.once("close", () => tar.kill())
  await pipeline(tar.stdout, out, { end: false })
  const code = await exited
  if (code !== 0) {
    console.warn(`[pi-lab server] tar of ${query.relPath} failed (${code}): ${stderr.trim()}`)
    out.destroy()
    return
  }
  out.end()
}

/**
 * `PUT /files/upload?workspaceId=&relPath=&replace=0|1`: write the body to
 * `relPath` (missing folders are made). The body goes to a temp file next to
 * the target, renamed over it only once complete, so an interrupted upload
 * leaves the old file as it was. An existing entry gives 409 unless
 * `replace=1` (a folder is never replaced).
 */
export async function handleUpload(
  ctx: AppContext,
  url: URL,
  request: IncomingMessage,
  out: ServerResponse,
): Promise<void> {
  // An answer before the body is read still reads (and drops) the body, so the
  // client's send ends normally and it reads the answer.
  out.once("finish", () => request.resume())
  const query = entryQuery(url)
  if (!query) return reply(out, 400, "workspaceId and relPath are required")
  const replace = url.searchParams.get("replace") === "1"
  const target = await uploadTarget(ctx, query).catch((error: unknown) => {
    reply(out, failureStatus(error), errorMessage(error))
    return null
  })
  if (target === null) return
  const existing = await lstat(target).catch(() => null)
  if (existing?.isDirectory()) return reply(out, 409, `${query.relPath} is a folder`)
  if (existing && !replace) return reply(out, 409, `${query.relPath} already exists`)
  const temp = join(
    dirname(target),
    `.${basename(target)}${UPLOAD_TEMP_MARK}${process.pid}-${Date.now()}`,
  )
  const written = await pipeline(request, createWriteStream(temp, { flags: "wx" })).then(
    () => true,
    async (error: unknown) => {
      await rm(temp, { force: true })
      console.warn(`[pi-lab server] upload of ${query.relPath} stopped: ${errorMessage(error)}`)
      return false
    },
  )
  if (!written) {
    if (!out.destroyed) reply(out, 400, "The upload ended before the whole file arrived")
    return
  }
  await rename(temp, target)
  out.writeHead(204).end()
}

/** The upload's absolute target; its folder is made and must stay inside the workspace. */
async function uploadTarget(
  ctx: AppContext,
  input: { workspaceId: string; relPath: string },
): Promise<string> {
  const workspace = requireWorkspace(ctx.db, input.workspaceId)
  const base = await realpath(workspaceWorkingDir(ctx.db, workspace))
  const target = resolveInsideDir(base, input.relPath)
  // Check the nearest existing folder before making any, so a symlink to a
  // folder outside the workspace cannot get folders made there.
  let existing = dirname(target)
  while (!(await lstat(existing).catch(() => null))) existing = dirname(existing)
  requireInside(base, await realpath(existing))
  await mkdir(dirname(target), { recursive: true })
  const folder = await realpath(dirname(target))
  requireInside(base, folder)
  return join(folder, basename(target))
}

/** Throws FORBIDDEN unless `folder` (a real path) is `base` or inside it. */
function requireInside(base: string, folder: string): void {
  const rel = relative(base, folder)
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Cannot upload outside the workspace" })
  }
}
