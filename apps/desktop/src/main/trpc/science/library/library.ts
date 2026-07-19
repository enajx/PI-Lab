import { stat } from "node:fs/promises"
import { basename, resolve } from "node:path"
import {
  coerceLibrarySource,
  type FolderSource,
  getSettingsOrDefaults,
  type LibrarySource,
  LOCAL_LIBRARY_ID,
  SETTINGS_ROW_ID,
  settings,
  type ZoteroSource,
} from "@pi-lab/local-db"
import { z } from "zod"
import { withMeaningfulActivity } from "../../../caffeine"
import type { HttpFetch } from "../../context"
import { publicProcedure, router } from "../../trpc"
import { attachViaBridge, attachViaWebApi } from "./attach"
import { listFolderCollections, listFolderItems, resolveWithin } from "./folder"
import {
  type LibraryCollection,
  type LibraryPaper,
  parseZoteroCollections,
  parseZoteroItems,
} from "./parse"
import {
  defaultZoteroDataDir,
  NO_LOCAL_FILE_MESSAGE,
  parseZoteroAttachments,
  pickBestAttachment,
  resolveAttachmentPath,
  type ZoteroAttachment,
} from "./zoteroAttachments"

/**
 * Library science tab (AGENTS.md "Scope" "Science tabs") — v1 is **connect + browse**:
 * store a library source locally and browse its collections and items. A source is
 * either **Zotero** (local desktop API or cloud Web API) or a plain **local folder** of
 * PDFs for researchers who don't use Zotero. Deep two-way sync, citation export, and
 * paper recommendations are explicitly v2 and absent here.
 *
 * Zotero HTTP goes through the injected {@link AppContext.httpFetch} so the suite mocks
 * Zotero with zero network (md/engineering/testing-and-build.md); the folder source reads the disk
 * directly (see `folder.ts`) and opens files through {@link AppContext.openPath}. Not-
 * configured and request failures are returned as **typed results**, never thrown — the
 * UI renders them as states. The stored Zotero API key is never logged.
 */

const ZOTERO_API = "https://api.zotero.org"
/** Local desktop API (Zotero) — same v3 read API served from the on-disk DB, no key. */
const ZOTERO_LOCAL_API = "http://localhost:23119/api"
const FETCH_TIMEOUT_MS = 12_000
/** The local-detection probe is on the UI's critical path, so it fails fast. */
const DETECT_TIMEOUT_MS = 2_500

/** Connection state surfaced to the UI — presence + non-secret identifiers only. */
export interface LibraryStatus {
  connected: boolean
  /** Which source backs the connection (`zotero` or a local `folder`). Present when connected. */
  kind?: LibrarySource["kind"]
  /** Zotero only — which Zotero backend the connection uses. */
  mode?: ZoteroSource["mode"]
  /** Zotero only. */
  libraryType?: ZoteroSource["libraryType"]
  /** Zotero only. */
  libraryId?: string
  /** Folder source only — the absolute folder path being browsed. */
  folderPath?: string
  /**
   * Whether file attachment is available: true for Zotero web; for Zotero local only
   * when a debug-bridge token is stored; always false for a folder (read-only). Present
   * only when connected; never the token.
   */
  canWrite?: boolean
}

/** A successful item list, or a typed reason it couldn't be produced. */
export type ListItemsResult =
  | { ok: true; items: LibraryPaper[]; truncated?: boolean }
  | { ok: false; reason: "not-connected" | "error"; message?: string }

/** A successful collection list, or a typed reason it couldn't be produced. */
export type ListCollectionsResult =
  | { ok: true; collections: LibraryCollection[] }
  | { ok: false; reason: "not-connected" | "error"; message?: string }

/** Whether the local Zotero desktop API is reachable (backs the connect chooser). */
export type DetectLocalResult = { reachable: boolean; message?: string }

/** Outcome of attaching a file to a library item — typed, never a throw. */
export type AttachFileResult =
  | { ok: true; attachmentKey: string }
  | { ok: false; reason: "not-connected" | "writes-disabled" | "error"; message?: string }

/**
 * Outcome of opening a library item's local copy with the OS default app — typed, never
 * a throw. `no-local-file` is the Zotero "not downloaded / no file attachment" case (a
 * real, surfaced outcome, not a silent miss); the renderer shows `message` regardless of
 * reason, so adding a reason is non-breaking.
 */
export type OpenItemResult =
  | { ok: true }
  | {
      ok: false
      reason: "not-connected" | "not-supported" | "no-local-file" | "error"
      message?: string
    }

const connectInput = z.union([
  z.object({
    kind: z.literal("zotero"),
    mode: z.literal("local"),
    // Zero-config: default to the personal library (`/users/0`). The advanced
    // picker may override these; a bridge token unlocks writes.
    libraryType: z.enum(["user", "group"]).default("user"),
    libraryId: z.string().min(1).default(LOCAL_LIBRARY_ID),
    bridgeToken: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("zotero"),
    mode: z.literal("web"),
    apiKey: z.string().min(1),
    libraryType: z.enum(["user", "group"]),
    libraryId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("folder"),
    /** Absolute path chosen via `system.pickDirectory`; validated to be a directory on connect. */
    folderPath: z.string().min(1),
  }),
])

const listItemsInput = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    start: z.number().int().min(0).optional(),
    /** When set, list the top-level items of this collection instead of the whole library. */
    collectionKey: z.string().min(1).optional(),
  })
  .optional()

/** When `parentKey` is set, list its subcollections; otherwise the top-level collections. */
const listCollectionsInput = z.object({ parentKey: z.string().min(1).optional() }).optional()

const attachFileInput = z.object({
  /** Parent Zotero item key (a `LibraryPaper.id` from the list). */
  itemKey: z.string().min(1),
  /** Absolute path to the file to attach (from `system.pickFile`). */
  filePath: z.string().min(1),
  /** Attachment display title; defaults to the file's basename. */
  title: z.string().min(1).optional(),
})

/** Open a folder item by its `LibraryPaper.id` (a path relative to the folder root). */
const openItemInput = z.object({ path: z.string().min(1) })

/** Open a Zotero item's best local attachment by its item key (a `LibraryPaper.id`). */
const openZoteroItemInput = z.object({ itemKey: z.string().min(1) })

/**
 * Read the stored library source (or null when not configured), normalizing legacy rows
 * (written before `kind`/`mode` existed) to the discriminated union. This is the single
 * coercion site — every procedure reads through it.
 */
function readSource(db: Parameters<typeof getSettingsOrDefaults>[0]): LibrarySource | null {
  return coerceLibrarySource(getSettingsOrDefaults(db).zotero)
}

/** Upsert the stored source (or `null` to disconnect) into the singleton settings row. */
function writeSource(
  db: Parameters<typeof getSettingsOrDefaults>[0],
  source: LibrarySource | null,
): void {
  const now = Date.now()
  db.insert(settings)
    .values({ id: SETTINGS_ROW_ID, zotero: source, updatedAt: now })
    .onConflictDoUpdate({ target: settings.id, set: { zotero: source, updatedAt: now } })
    .run()
}

/** The library status payload for a connected source (presence + non-secret identifiers). */
function statusOf(source: LibrarySource): LibraryStatus {
  if (source.kind === "folder") {
    return { connected: true, kind: "folder", folderPath: source.folderPath, canWrite: false }
  }
  return {
    connected: true,
    kind: "zotero",
    mode: source.mode,
    libraryType: source.libraryType,
    libraryId: source.libraryId,
    canWrite: sourceCanWrite(source),
  }
}

/** Library API path prefix for a Zotero source (`/users/{id}` or `/groups/{id}`). */
function libraryBase(source: ZoteroSource): string {
  return `/${source.libraryType === "group" ? "groups" : "users"}/${source.libraryId}`
}

/** Whether the source can write file attachments (Zotero web always; local needs a token; folder never). */
function sourceCanWrite(source: LibrarySource): boolean {
  if (source.kind !== "zotero") return false
  return source.mode === "web" ? true : Boolean(source.bridgeToken)
}

/**
 * Augment a failed local-connect message with the enablement steps. Zotero returns
 * a bare "Local API is not enabled" 403 when the desktop app is running but the API
 * toggle is off — the most common first-run snag — so we point the user straight at it.
 */
function connectErrorMessage(source: ZoteroSource, message: string): string {
  if (source.mode === "local" && /local api is not enabled/i.test(message)) {
    return `${message}. In Zotero, enable Settings → Advanced → General → “Allow other applications on this computer to communicate with Zotero,” then try again.`
  }
  return message
}

/** Read base URL + auth headers for a Zotero source's mode (local sends no key). */
function zoteroReadTarget(source: ZoteroSource): {
  base: string
  headers: Record<string, string>
} {
  if (source.mode === "local") {
    return { base: ZOTERO_LOCAL_API, headers: { "Zotero-API-Version": "3" } }
  }
  return {
    base: ZOTERO_API,
    headers: { "Zotero-API-Version": "3", "Zotero-API-Key": source.apiKey },
  }
}

/**
 * GET a Zotero API path for a source, timing out and returning a typed outcome instead
 * of throwing. The base URL and auth follow the source's mode: cloud with a
 * `Zotero-API-Key` header (never the URL, never logged), or the local desktop API with
 * no key. Used by both the connect probe and item listing.
 */
async function zoteroGet(
  httpFetch: HttpFetch,
  source: ZoteroSource,
  path: string,
): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  const { base, headers } = zoteroReadTarget(source)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await httpFetch(`${base}${path}`, { headers, signal: controller.signal })
    if (!res.ok) {
      // Surface Zotero's own reason when it's a short plain-text message — e.g. a
      // local-mode 403 returns "Local API is not enabled", far more actionable than
      // the bare status line. Skip empty/HTML/oversized bodies.
      const body = (await res.text().catch(() => "")).trim()
      const detail =
        body && body !== "null" && body.length <= 200 && !body.startsWith("<") ? body : ""
      return {
        ok: false,
        message: detail
          ? `Zotero API ${res.status}: ${detail}`
          : `Zotero API ${res.status} ${res.statusText}`,
      }
    }
    return { ok: true, data: await res.json() }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Zotero request failed" }
  } finally {
    clearTimeout(timer)
  }
}

export const libraryRouter = router({
  /**
   * Current connection state for the UI (presence + non-secret identifiers
   * only). Reads the singleton settings row; never writes, never returns the key.
   */
  getStatus: publicProcedure.query(({ ctx }): LibraryStatus => {
    const source = readSource(ctx.db)
    return source ? statusOf(source) : { connected: false }
  }),

  /**
   * Lightweight reachability probe for the local desktop API, backing the connect
   * chooser's live "Zotero detected" hint. Uses a short timeout (the UI waits on it)
   * and never throws — an unreachable server is a plain `{ reachable: false }`.
   */
  detectLocal: publicProcedure.query(async ({ ctx }): Promise<DetectLocalResult> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS)
    try {
      const res = await ctx.httpFetch(
        `${ZOTERO_LOCAL_API}/users/${LOCAL_LIBRARY_ID}/items?limit=1`,
        {
          headers: { "Zotero-API-Version": "3" },
          signal: controller.signal,
        },
      )
      return { reachable: res.ok }
    } catch (error) {
      return { reachable: false, message: error instanceof Error ? error.message : "unreachable" }
    } finally {
      clearTimeout(timer)
    }
  }),

  /**
   * Validate + persist a library source. For Zotero a light probe (one `/items?limit=1`
   * call) confirms the key/library before saving; for a folder we confirm the path is an
   * existing directory. Either way an obviously-bad config is rejected up front rather
   * than silently stored. On success the source is upserted into the singleton settings row.
   */
  connect: publicProcedure.input(connectInput).mutation(
    ({ ctx, input }): Promise<LibraryStatus> =>
      withMeaningfulActivity(ctx.caffeine, "library:connect", async () => {
        if (input.kind === "folder") {
          const folderPath = resolve(input.folderPath.trim())
          const isDir = await stat(folderPath)
            .then((s) => s.isDirectory())
            .catch(() => false)
          if (!isDir) throw new Error(`Folder not found, or not a directory: ${folderPath}`)
          const source: FolderSource = { kind: "folder", folderPath }
          writeSource(ctx.db, source)
          return statusOf(source)
        }

        const source: ZoteroSource =
          input.mode === "local"
            ? {
                kind: "zotero",
                mode: "local",
                libraryType: input.libraryType,
                libraryId: input.libraryId.trim(),
                ...(input.bridgeToken ? { bridgeToken: input.bridgeToken.trim() } : {}),
              }
            : {
                kind: "zotero",
                mode: "web",
                apiKey: input.apiKey.trim(),
                libraryType: input.libraryType,
                libraryId: input.libraryId.trim(),
              }

        // Probe before persisting so an unreachable local server or a bad key/library
        // is rejected up front rather than silently stored. Local probes carry no key.
        const probe = await zoteroGet(ctx.httpFetch, source, `${libraryBase(source)}/items?limit=1`)
        if (!probe.ok) throw new Error(connectErrorMessage(source, probe.message))

        writeSource(ctx.db, source)
        return statusOf(source)
      }),
  ),

  /** Clear the stored library source (any credentials are removed locally). */
  disconnect: publicProcedure.mutation(({ ctx }): LibraryStatus => {
    writeSource(ctx.db, null)
    return { connected: false }
  }),

  /**
   * List the top-level items of the connected library, parsed into UI-ready papers.
   * Zotero reads its API (newest-modified first); a folder lists `.pdf` files (the whole
   * tree for "All items", a subfolder's direct files when scoped by `collectionKey`).
   * Returns a typed `not-connected` result (not a throw) when no source is stored, and a
   * typed `error` on a failed read, so the tab can render each as a distinct state.
   */
  listItems: publicProcedure
    .input(listItemsInput)
    .query(async ({ ctx, input }): Promise<ListItemsResult> => {
      const source = readSource(ctx.db)
      if (!source) return { ok: false, reason: "not-connected" }

      if (source.kind === "folder") {
        // Zotero is unchanged below (it lists its page as before); the folder source caps
        // its listing as a crash backstop and flags `truncated` so the UI can say so.
        const listed = await listFolderItems(source.folderPath, input?.collectionKey)
        if (listed == null)
          return { ok: false, reason: "error", message: "Path is outside the folder." }
        return { ok: true, items: listed.items, truncated: listed.truncated }
      }

      const limit = input?.limit ?? 50
      const start = input?.start ?? 0
      // Scope to a collection's top-level items when asked; else the whole library.
      const itemsBase = input?.collectionKey
        ? `${libraryBase(source)}/collections/${input.collectionKey}/items/top`
        : `${libraryBase(source)}/items/top`
      const path = `${itemsBase}?limit=${limit}&start=${start}&sort=dateModified`
      const res = await zoteroGet(ctx.httpFetch, source, path)
      if (!res.ok) return { ok: false, reason: "error", message: res.message }
      return { ok: true, items: parseZoteroItems(res.data) }
    }),

  /**
   * List collections for the browser's default view: the top-level collections, or the
   * subcollections of `parentKey` when drilling in. Same typed-result discipline as
   * `listItems`. For Zotero the local and cloud APIs share the `/collections` shape; for
   * a folder the immediate subdirectories are the collections.
   */
  listCollections: publicProcedure
    .input(listCollectionsInput)
    .query(async ({ ctx, input }): Promise<ListCollectionsResult> => {
      const source = readSource(ctx.db)
      if (!source) return { ok: false, reason: "not-connected" }

      if (source.kind === "folder") {
        const collections = await listFolderCollections(source.folderPath, input?.parentKey)
        if (collections == null)
          return { ok: false, reason: "error", message: "Path is outside the folder." }
        return { ok: true, collections }
      }

      const base = libraryBase(source)
      const path = input?.parentKey
        ? `${base}/collections/${input.parentKey}/collections?limit=100&sort=title`
        : `${base}/collections/top?limit=100&sort=title`
      const res = await zoteroGet(ctx.httpFetch, source, path)
      if (!res.ok) return { ok: false, reason: "error", message: res.message }
      return { ok: true, collections: parseZoteroCollections(res.data) }
    }),

  /**
   * Attach a file to an existing library item. Zotero only — the two modes write very
   * differently (see `attach.ts`): local runs Zotero's own `linkFromFile` over the debug
   * bridge (needs a bridge token), web uploads via the Web API file flow (needs a
   * write-enabled key). A folder source is read-only, so it returns `writes-disabled`.
   * Returns a typed result — never a throw.
   */
  attachFile: publicProcedure.input(attachFileInput).mutation(
    ({ ctx, input }): Promise<AttachFileResult> =>
      withMeaningfulActivity(ctx.caffeine, "library:attach-file", async () => {
        const source = readSource(ctx.db)
        if (!source) return { ok: false, reason: "not-connected" }
        if (source.kind !== "zotero") {
          return {
            ok: false,
            reason: "writes-disabled",
            message: "The folder source is read-only — attaching files needs a Zotero connection.",
          }
        }
        const title = input.title ?? basename(input.filePath)
        return source.mode === "local"
          ? attachViaBridge(ctx.httpFetch, source, input.itemKey, input.filePath, title)
          : attachViaWebApi(ctx.httpFetch, source, input.itemKey, input.filePath, title)
      }),
  ),

  /**
   * Open a folder item (a PDF) with the OS default application. Folder source only — the
   * `path` is a `LibraryPaper.id` (relative to the folder root), resolved under the stored
   * root with a traversal guard so a crafted path can't open a file outside the chosen
   * folder. Returns a typed result; the actual open is the injected `ctx.openPath`.
   */
  openItem: publicProcedure
    .input(openItemInput)
    .mutation(async ({ ctx, input }): Promise<OpenItemResult> => {
      const source = readSource(ctx.db)
      if (!source) return { ok: false, reason: "not-connected" }
      if (source.kind !== "folder") {
        return {
          ok: false,
          reason: "not-supported",
          message: "Opening files is only available for a local folder source.",
        }
      }
      const abs = resolveWithin(source.folderPath, input.path)
      if (abs == null) return { ok: false, reason: "error", message: "Path is outside the folder." }
      const error = await ctx.openPath(abs)
      if (error) return { ok: false, reason: "error", message: error }
      return { ok: true }
    }),

  /**
   * Open a Zotero item's **local copy** (its best file attachment — a PDF if present) with
   * the OS default app. Zotero source only. We read the item's child attachments through
   * the same mode-aware Zotero GET as the rest of the router (local sends no key, web
   * sends the key header), pick the best file attachment, resolve it to an on-disk path by
   * link mode (`linked_file` → `data.path`; `imported_file`/`imported_url` →
   * `{zoteroDataDir}/storage/{key}/{filename}`), and verify the file exists before opening
   * it via the injected `ctx.openPath`. When nothing resolves on disk (web copy not
   * downloaded, no file attachment, or the file is missing) we return a typed
   * `no-local-file` result with a clear message rather than failing silently.
   */
  openZoteroItem: publicProcedure
    .input(openZoteroItemInput)
    .mutation(async ({ ctx, input }): Promise<OpenItemResult> => {
      const source = readSource(ctx.db)
      if (!source) return { ok: false, reason: "not-connected" }
      if (source.kind !== "zotero") {
        return {
          ok: false,
          reason: "not-supported",
          message: "Opening a Zotero local copy needs a Zotero connection.",
        }
      }
      const dataDir = defaultZoteroDataDir()
      // Pick the best attachment, resolve its on-disk path, and return it only if the file exists.
      const resolveExisting = async (atts: ZoteroAttachment[]): Promise<string | null> => {
        const attachment = pickBestAttachment(atts)
        const candidate = attachment ? resolveAttachmentPath(attachment, dataDir) : null
        if (!candidate) return null
        const exists = await stat(candidate)
          .then((s) => s.isFile())
          .catch(() => false)
        return exists ? candidate : null
      }

      // 1) The common case: a parent item with child attachments (a paper + its downloaded PDF/snapshot).
      const childrenRes = await zoteroGet(
        ctx.httpFetch,
        source,
        `${libraryBase(source)}/items/${input.itemKey}/children`,
      )
      if (!childrenRes.ok) return { ok: false, reason: "error", message: childrenRes.message }
      let abs = await resolveExisting(parseZoteroAttachments(childrenRes.data))

      // 2) Fallback: the item is itself a standalone attachment (a raw PDF or saved web page with
      //    no parent) — resolve the item's own file rather than its (nonexistent) children.
      if (!abs) {
        const itemRes = await zoteroGet(
          ctx.httpFetch,
          source,
          `${libraryBase(source)}/items/${input.itemKey}`,
        )
        if (itemRes.ok) abs = await resolveExisting(parseZoteroAttachments([itemRes.data]))
      }

      if (!abs) return { ok: false, reason: "no-local-file", message: NO_LOCAL_FILE_MESSAGE }
      const error = await ctx.openPath(abs)
      if (error) return { ok: false, reason: "error", message: error }
      return { ok: true }
    }),
})
