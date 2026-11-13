import { randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { basename, extname } from "node:path"
import { Readable } from "node:stream"

/** URL scheme of Analysis video and gif previews (registered in `reportScheme.ts`). */
export const MEDIA_SCHEME = "pi-lab-media"

/**
 * Content types by extension. Chromium plays H.264 `.mov` files when they are
 * served as MP4, and Matroska as WebM; it cannot play AVI, which then shows the
 * player's error.
 */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/webm",
  ".ogv": "video/ogg",
  ".avi": "video/x-msvideo",
  ".gif": "image/gif",
}

/**
 * Short-lived grants that let the renderer's `<video>` and `<img>` stream one
 * project file each through `pi-lab-media://<token>/<name>`. The router checks
 * the file is inside the project (after symlinks) before granting it; a grant
 * maps only its token to that one file. Requests are served from the file in
 * chunks, with HTTP byte ranges so the player can seek, never read whole.
 */
export class MediaGrants {
  readonly #files = new Map<string, string>()

  /** Grant the renderer one file (an absolute, already checked path); returns its URL. */
  grant(absPath: string): string {
    const token = randomUUID()
    this.#files.set(token, absPath)
    return `${MEDIA_SCHEME}://${token}/${encodeURIComponent(basename(absPath))}`
  }

  /** Revoke a URL from {@link grant}. Unknown URLs are ignored. */
  revoke(url: string): void {
    this.#files.delete(new URL(url).hostname)
  }

  /** Revoke every grant (app shutdown). */
  clear(): void {
    this.#files.clear()
  }

  /** Serve a `pi-lab-media://` request: the whole file, or one byte range of it. */
  async handle(request: Request): Promise<Response> {
    const absPath = this.#files.get(new URL(request.url).hostname)
    if (absPath === undefined) return new Response("Media preview expired", { status: 404 })
    const info = await stat(absPath)
    const type = MEDIA_TYPES[extname(absPath).toLowerCase()] ?? "application/octet-stream"
    const size = info.size
    const range = parseRange(request.headers.get("range"), size)
    if (range === "invalid") {
      return new Response("Range not satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${size}` },
      })
    }
    const { start, end } = range ?? { start: 0, end: size - 1 }
    const body =
      size === 0
        ? null
        : (Readable.toWeb(createReadStream(absPath, { start, end })) as ReadableStream<Uint8Array>)
    const headers: Record<string, string> = {
      "content-type": type,
      "accept-ranges": "bytes",
      "content-length": String(size === 0 ? 0 : end - start + 1),
    }
    if (range === null) return new Response(body, { status: 200, headers })
    headers["content-range"] = `bytes ${start}-${end}/${size}`
    return new Response(body, { status: 206, headers })
  }
}

/**
 * Parse a single `bytes=a-b`, `bytes=a-` or `bytes=-n` range. Null when there
 * is no header (the whole file); "invalid" when it cannot be served.
 */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | "invalid" {
  if (header === null) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === "" && match[2] === "")) return "invalid"
  if (match[1] === "") {
    const suffix = Number(match[2])
    if (suffix === 0) return "invalid"
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1)
  if (start >= size || end < start) return "invalid"
  return { start, end }
}

/** The app's one set of media grants, shared by the router and the protocol handler. */
export const analysisMedia = new MediaGrants()
