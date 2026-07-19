import { createHash, randomBytes } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { basename } from "node:path"
import type { ZoteroLocalSource, ZoteroWebSource } from "@pi-lab/local-db"
import type { HttpFetch } from "../../context"
import type { AttachFileResult } from "./library"

/**
 * The two write paths behind `science.library.attachFile`. Reads can't write Zotero
 * over HTTP (the local API is GET-only; pyzotero has no local write), so the two
 * modes diverge sharply:
 *
 *  - **local** drives Zotero's *own* `Zotero.Attachments.linkFromFile` over the debug
 *    bridge — Zotero performs the write, so cache/schema/sync stay correct, and the
 *    file stays on disk as a LINKED attachment (repo-native). Needs a bridge token.
 *  - **web** uses the Web API file-upload flow (create attachment item → authorize →
 *    upload to storage → register), copying the bytes into Zotero File Storage.
 *
 * Both take the injected `httpFetch` so the suite stubs them with zero network, and
 * both return a typed {@link AttachFileResult} (never throw for expected failures).
 */

const ZOTERO_API = "https://api.zotero.org"
const ZOTERO_BRIDGE = "http://127.0.0.1:23119/debug-bridge/execute"
const ATTACH_TIMEOUT_MS = 30_000

/** Cloud library path prefix for a web connection (`https://api.zotero.org/users/{id}`). */
function webBase(conn: ZoteroWebSource): string {
  return `${ZOTERO_API}/${conn.libraryType === "group" ? "groups" : "users"}/${conn.libraryId}`
}

/** Best-effort content type from a filename extension (markdown notes are the common case). */
function contentTypeFor(filename: string): string {
  switch (filename.toLowerCase().split(".").pop()) {
    case "md":
    case "markdown":
      return "text/markdown"
    case "pdf":
      return "application/pdf"
    case "txt":
      return "text/plain"
    case "json":
      return "application/json"
    case "csv":
      return "text/csv"
    default:
      return "application/octet-stream"
  }
}

/**
 * Attach a file to a local-library item by running Zotero's own attachment code via
 * the debug bridge. Creates a LINKED attachment (the file is left in place). Requires
 * a stored bridge token; absent ⇒ a typed `writes-disabled` result.
 */
export async function attachViaBridge(
  httpFetch: HttpFetch,
  conn: ZoteroLocalSource,
  parentKey: string,
  filePath: string,
  title: string,
): Promise<AttachFileResult> {
  if (!conn.bridgeToken) {
    return {
      ok: false,
      reason: "writes-disabled",
      message:
        "Set the Zotero debug-bridge token in Settings → Zotero to attach files in local mode.",
    }
  }
  // JSON.stringify neutralizes quoting of the interpolated path/key/title.
  const js =
    `const parentID = Zotero.Items.getIDFromLibraryAndKey(Zotero.Libraries.userLibraryID, ${JSON.stringify(parentKey)});` +
    `if (!parentID) return "ERR:no-parent";` +
    `const att = await Zotero.Attachments.linkFromFile({ file: ${JSON.stringify(filePath)}, parentItemID: parentID, title: ${JSON.stringify(title)} });` +
    "return att.key;"

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ATTACH_TIMEOUT_MS)
  try {
    const res = await httpFetch(ZOTERO_BRIDGE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${conn.bridgeToken}`,
        "Content-Type": "application/javascript",
      },
      body: js,
      signal: controller.signal,
    })
    if (!res.ok) {
      return {
        ok: false,
        reason: "error",
        message: `Zotero bridge ${res.status} ${res.statusText}`,
      }
    }
    // The bridge echoes the JS return value; tolerate a JSON-quoted string.
    const key = (await res.text()).trim().replace(/^"|"$/g, "")
    if (!key || key.startsWith("ERR:")) {
      return {
        ok: false,
        reason: "error",
        message:
          key === "ERR:no-parent"
            ? "Item not found in the local library."
            : key || "Bridge returned no attachment key.",
      }
    }
    return { ok: true, attachmentKey: key }
  } catch (error) {
    return {
      ok: false,
      reason: "error",
      message: error instanceof Error ? error.message : "Zotero bridge request failed",
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Attach a file to a cloud-library item via the Web API file-upload flow (create →
 * authorize → upload → register). The bytes are copied into Zotero File Storage; the
 * key must have library write access (a read-only key 403s at the create step). The
 * storage upload is a fresh request with NO Zotero headers.
 */
export async function attachViaWebApi(
  httpFetch: HttpFetch,
  conn: ZoteroWebSource,
  parentKey: string,
  filePath: string,
  title: string,
): Promise<AttachFileResult> {
  let bytes: Buffer
  let mtime: number
  try {
    bytes = await readFile(filePath)
    mtime = Math.round((await stat(filePath)).mtimeMs)
  } catch (error) {
    return {
      ok: false,
      reason: "error",
      message: error instanceof Error ? error.message : "Could not read file",
    }
  }

  const filename = basename(filePath)
  const md5 = createHash("md5").update(bytes).digest("hex")
  const contentType = contentTypeFor(filename)
  const base = webBase(conn)
  const authHeaders = { "Zotero-API-Version": "3", "Zotero-API-Key": conn.apiKey }

  // 1. Create the attachment item (imported_file) under the parent.
  const createRes = await httpFetch(`${base}/items`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
      "Zotero-Write-Token": randomBytes(16).toString("hex"),
    },
    body: JSON.stringify([
      {
        itemType: "attachment",
        parentItem: parentKey,
        linkMode: "imported_file",
        title,
        filename,
        contentType,
        md5,
        mtime,
      },
    ]),
  })
  if (!createRes.ok) {
    return {
      ok: false,
      reason: "error",
      message: `Create attachment ${createRes.status} ${createRes.statusText}`,
    }
  }
  let created: {
    successful?: Record<string, { key?: string }>
    failed?: Record<string, { message?: string }>
  }
  try {
    created = (await createRes.json()) as typeof created
  } catch {
    return { ok: false, reason: "error", message: "Unexpected response creating the attachment." }
  }
  const attachmentKey = created.successful?.["0"]?.key
  if (!attachmentKey) {
    return {
      ok: false,
      reason: "error",
      message:
        created.failed?.["0"]?.message ??
        "Zotero rejected the attachment (a write-enabled key is required).",
    }
  }

  // 2. Authorize the upload.
  const authRes = await httpFetch(`${base}/items/${attachmentKey}/file`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/x-www-form-urlencoded",
      "If-None-Match": "*",
    },
    body: new URLSearchParams({
      md5,
      filename,
      filesize: String(bytes.byteLength),
      mtime: String(mtime),
    }).toString(),
  })
  if (!authRes.ok) {
    return {
      ok: false,
      reason: "error",
      message: `Upload auth ${authRes.status} ${authRes.statusText}`,
    }
  }
  let auth: {
    exists?: number
    url?: string
    contentType?: string
    prefix?: string
    suffix?: string
    uploadKey?: string
  }
  try {
    auth = (await authRes.json()) as typeof auth
  } catch {
    return { ok: false, reason: "error", message: "Malformed upload authorization from Zotero." }
  }
  // Dedup: identical file already in storage → already attached, nothing to upload.
  if (auth.exists) return { ok: true, attachmentKey }
  if (!auth.url || !auth.uploadKey || auth.prefix == null || auth.suffix == null) {
    return { ok: false, reason: "error", message: "Malformed upload authorization from Zotero." }
  }

  // 3. Upload to storage — a fresh request with NONE of the Zotero headers.
  const uploadRes = await httpFetch(auth.url, {
    method: "POST",
    headers: { "Content-Type": auth.contentType ?? contentType },
    body: Buffer.concat([
      Buffer.from(auth.prefix, "utf8"),
      bytes,
      Buffer.from(auth.suffix, "utf8"),
    ]),
  })
  if (!uploadRes.ok) {
    return {
      ok: false,
      reason: "error",
      message: `Upload ${uploadRes.status} ${uploadRes.statusText}`,
    }
  }

  // 4. Register the upload against the attachment item.
  const regRes = await httpFetch(`${base}/items/${attachmentKey}/file`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/x-www-form-urlencoded",
      "If-None-Match": "*",
    },
    body: new URLSearchParams({ upload: auth.uploadKey }).toString(),
  })
  if (!regRes.ok) {
    return {
      ok: false,
      reason: "error",
      message: `Register upload ${regRes.status} ${regRes.statusText}`,
    }
  }
  return { ok: true, attachmentKey }
}
