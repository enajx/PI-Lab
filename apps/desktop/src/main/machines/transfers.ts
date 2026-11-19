import { spawn } from "node:child_process"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { request } from "node:http"
import { basename, join, relative, sep } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { TOKEN_HEADER } from "../../server/access"
import { DOWNLOAD_PATH, ENTRY_HEADER, UPLOAD_PATH } from "../../server/transfers"

/**
 * Client side of Download and Upload for projects on another machine: plain
 * HTTP to the machine's server through its SSH tunnel (server/transfers.ts).
 */

export interface TransferEndpoint {
  port: number
  token: string
}

export interface WorkspaceEntry {
  workspaceId: string
  relPath: string
}

function transferUrl(endpoint: TransferEndpoint, path: string, query: Record<string, string>) {
  return `http://127.0.0.1:${endpoint.port}${path}?${new URLSearchParams(query)}`
}

/**
 * Save a remote file or folder at `destination` on this Mac. A file is written
 * to a temp name and renamed when complete; a folder (a tar stream) is unpacked
 * into `destination`, made when missing. Throws with the server's message.
 */
export async function downloadEntry(
  endpoint: TransferEndpoint,
  entry: WorkspaceEntry,
  destination: string,
): Promise<void> {
  const response = await fetch(transferUrl(endpoint, DOWNLOAD_PATH, { ...entry }), {
    headers: { [TOKEN_HEADER]: endpoint.token },
    redirect: "error",
  })
  if (response.status !== 200 || !response.body) {
    throw new Error(`Download of ${entry.relPath} failed: ${await response.text()}`)
  }
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)
  if (response.headers.get(ENTRY_HEADER) === "file") {
    const temp = `${destination}.pi-lab-download`
    await pipeline(body, createWriteStream(temp)).catch(async (error: unknown) => {
      await rm(temp, { force: true })
      throw error
    })
    await rename(temp, destination)
    return
  }
  await mkdir(destination, { recursive: true })
  const tar = spawn("tar", ["-xf", "-", "-C", destination], { stdio: ["pipe", "ignore", "pipe"] })
  let stderr = ""
  tar.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exited = new Promise<number | null>((resolve) => tar.once("close", resolve))
  await pipeline(body, tar.stdin)
  const code = await exited
  if (code !== 0) throw new Error(`Unpacking ${entry.relPath} failed: ${stderr.trim()}`)
}

/** PUT one local file; resolves with the HTTP status and the server's message. */
function putFile(
  endpoint: TransferEndpoint,
  entry: WorkspaceEntry,
  localPath: string,
  replace: boolean,
): Promise<{ status: number; message: string }> {
  return new Promise((resolve, reject) => {
    const put = request(
      transferUrl(endpoint, UPLOAD_PATH, { ...entry, replace: replace ? "1" : "0" }),
      { method: "PUT", headers: { [TOKEN_HEADER]: endpoint.token } },
      (response) => {
        let message = ""
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => {
          message += chunk
        })
        response.on("end", () => resolve({ status: response.statusCode ?? 0, message }))
        response.on("error", reject)
      },
    )
    put.on("error", reject)
    // A 409 answers before the body is read; the rest of the file is not needed then.
    pipeline(createReadStream(localPath), put).catch(reject)
  })
}

/** Every file under a local folder, with its path relative to the folder's parent (POSIX). */
async function filesUnder(folder: string): Promise<{ localPath: string; relPath: string }[]> {
  const parent = join(folder, "..")
  const entries = await readdir(folder, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const localPath = join(entry.parentPath, entry.name)
      return { localPath, relPath: relative(parent, localPath).split(sep).join("/") }
    })
}

/**
 * Upload local files and folders (with everything in them) into `folderRelPath`
 * of a remote workspace. A file that exists there is replaced only when
 * `confirmReplace` says so; otherwise it is skipped. Stops at the first error.
 */
export async function uploadEntries(
  endpoint: TransferEndpoint,
  target: { workspaceId: string; folderRelPath: string },
  localPaths: readonly string[],
  confirmReplace: (relPath: string) => Promise<boolean>,
): Promise<{ uploaded: string[]; skipped: string[] }> {
  const files: { localPath: string; relPath: string }[] = []
  for (const localPath of localPaths) {
    if ((await stat(localPath)).isDirectory()) files.push(...(await filesUnder(localPath)))
    else files.push({ localPath, relPath: basename(localPath) })
  }
  const uploaded: string[] = []
  const skipped: string[] = []
  for (const file of files) {
    const relPath = target.folderRelPath ? `${target.folderRelPath}/${file.relPath}` : file.relPath
    const entry = { workspaceId: target.workspaceId, relPath }
    let result = await putFile(endpoint, entry, file.localPath, false)
    if (result.status === 409 && (await confirmReplace(relPath))) {
      result = await putFile(endpoint, entry, file.localPath, true)
    }
    if (result.status === 409) {
      skipped.push(relPath)
      continue
    }
    if (result.status !== 204) throw new Error(`Upload of ${relPath} failed: ${result.message}`)
    uploaded.push(relPath)
  }
  return { uploaded, skipped }
}
