import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

/**
 * Pure helpers for resolving a Zotero item's child **attachments** to an on-disk file
 * for the Library tab's "open local copy" gesture (AGENTS.md "Scope" "Science tabs").
 * Kept free of tRPC, I/O, and credentials — mirroring `parse.ts` — so the parse →
 * pick → resolve chain is example-testable in isolation over the loose, partially-typed
 * payloads the Zotero API returns. The router (`library.ts`) fetches the `/children`
 * list and verifies file existence; everything here is a pure transform.
 */

/** Shown when no on-disk file resolves for a Zotero item (web copy, not downloaded, no file attachment). */
export const NO_LOCAL_FILE_MESSAGE = "No local copy available (not downloaded)."

/** Default Zotero data directory (storage lives at `~/Zotero/storage`). A Settings override is a later follow-up. */
export function defaultZoteroDataDir(): string {
  return join(homedir(), "Zotero")
}

/** One parsed Zotero attachment child — only the fields the resolver needs to find a file. */
export interface ZoteroAttachment {
  /** Attachment item key — the `storage/{key}` directory for imported files. */
  key: string
  /** Zotero link mode: `imported_file` | `imported_url` | `linked_file` | `linked_url`. */
  linkMode: string
  title?: string
  filename?: string
  /** For `linked_file`: the on-disk path Zotero recorded (absolute when usable). */
  path?: string
  contentType?: string
}

/** Trimmed string when non-empty, else undefined (local copy of parse.ts's private helper). */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Parse a Zotero `/items/{key}/children` response into {@link ZoteroAttachment}s. The
 * API returns an array of `{ key, data: { itemType, linkMode, filename, path,
 * contentType, title } }`; we keep only `itemType === "attachment"` rows that carry a
 * non-empty key and link mode. A non-array payload (or null) parses to an empty list
 * rather than throwing, mirroring `parseZoteroItems`.
 */
export function parseZoteroAttachments(payload: unknown): ZoteroAttachment[] {
  if (!Array.isArray(payload)) return []
  const out: ZoteroAttachment[] = []
  for (const row of payload) {
    const r = (row ?? {}) as {
      key?: string
      data?: {
        key?: string
        itemType?: string
        linkMode?: string
        filename?: string
        path?: string
        contentType?: string
        title?: string
      }
    }
    const data = r.data ?? {}
    if (data.itemType !== "attachment") continue
    const key = nonEmpty(r.key) ?? nonEmpty(data.key)
    const linkMode = nonEmpty(data.linkMode)
    if (!key || !linkMode) continue
    out.push({
      key,
      linkMode,
      title: nonEmpty(data.title),
      filename: nonEmpty(data.filename),
      path: nonEmpty(data.path),
      contentType: nonEmpty(data.contentType),
    })
  }
  return out
}

/** Whether an attachment looks like a PDF (by content type or filename extension). */
function isPdf(att: ZoteroAttachment): boolean {
  return (
    att.contentType === "application/pdf" || (att.filename ? /\.pdf$/i.test(att.filename) : false)
  )
}

/**
 * Pick the best file attachment to open: drop web-link attachments (`linked_url` — they
 * have no local file), then prefer a PDF, else the first remaining file attachment.
 * Returns undefined when none qualifies.
 */
export function pickBestAttachment(atts: ZoteroAttachment[]): ZoteroAttachment | undefined {
  const files = atts.filter((att) => att.linkMode !== "linked_url")
  return files.find(isPdf) ?? files[0]
}

/**
 * Resolve an attachment to an absolute on-disk path, or null when none applies:
 *  - `linked_file` — Zotero's recorded `path`, used only when already absolute.
 *  - `imported_file` / `imported_url` — `{dataDir}/storage/{key}/{filename}`.
 *  - anything else (e.g. `linked_url`) — null.
 * Path-only math (no I/O); the router verifies the file actually exists.
 */
export function resolveAttachmentPath(att: ZoteroAttachment, dataDir: string): string | null {
  switch (att.linkMode) {
    case "linked_file":
      return att.path && isAbsolute(att.path) ? att.path : null
    case "imported_file":
    case "imported_url":
      return att.filename ? join(dataDir, "storage", att.key, att.filename) : null
    default:
      return null
  }
}
