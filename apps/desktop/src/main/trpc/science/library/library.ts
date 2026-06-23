import {
  getSettingsOrDefaults,
  SETTINGS_ROW_ID,
  settings,
  type ZoteroConnection,
} from "@skipper/local-db"
import { z } from "zod"
import type { HttpFetch } from "../../context"
import { publicProcedure, router } from "../../trpc"
import { type LibraryPaper, parseSemanticScholarPapers, parseZoteroItems } from "./parse"

/**
 * Library science tab (AGENTS.md §1 "Science tabs") — v1 is **connect + browse +
 * look up**: store Zotero credentials locally, list the connected library, and
 * search papers via Semantic Scholar. Deep two-way sync, citation export, and
 * paper recommendations are explicitly v2 and absent here.
 *
 * All outbound HTTP goes through the injected {@link AppContext.httpFetch} so the
 * suite mocks Zotero / Semantic Scholar with zero network (AGENTS.md §14); the
 * live path is the platform `fetch`. Not-configured and request failures are
 * returned as **typed results**, never thrown — the UI renders them as states.
 * The stored Zotero API key is never logged.
 */

const ZOTERO_API = "https://api.zotero.org"
const SEMANTIC_SCHOLAR_API = "https://api.semanticscholar.org/graph/v1"
/** Polite, bounded field set + page size for the unauthenticated S2 endpoint. */
const SCHOLAR_FIELDS = "title,authors,year,abstract,externalIds,url"
const SCHOLAR_LIMIT = 20
const FETCH_TIMEOUT_MS = 12_000

/** Connection state surfaced to the UI — presence only, never the API key. */
export interface LibraryStatus {
  connected: boolean
  /** Present only when connected. */
  libraryType?: ZoteroConnection["libraryType"]
  /** Present only when connected. */
  libraryId?: string
}

/** A successful Zotero item list, or a typed reason it couldn't be produced. */
export type ListItemsResult =
  | { ok: true; items: LibraryPaper[] }
  | { ok: false; reason: "not-connected" | "error"; message?: string }

/** A successful Semantic Scholar search, or a typed error (never a throw). */
export type SearchResult = { ok: true; papers: LibraryPaper[] } | { ok: false; message: string }

const connectInput = z.object({
  apiKey: z.string().min(1),
  libraryType: z.enum(["user", "group"]),
  libraryId: z.string().min(1),
})

const listItemsInput = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    start: z.number().int().min(0).optional(),
  })
  .optional()

const searchInput = z.object({ query: z.string().min(1) })

/** Read the stored Zotero connection (or null when not configured). */
function readConnection(db: Parameters<typeof getSettingsOrDefaults>[0]): ZoteroConnection | null {
  return getSettingsOrDefaults(db).zotero ?? null
}

/** Library API path prefix for a connection (`/users/{id}` or `/groups/{id}`). */
function libraryBase(conn: ZoteroConnection): string {
  return `/${conn.libraryType === "group" ? "groups" : "users"}/${conn.libraryId}`
}

/**
 * GET a Zotero Web API path with the connection's key, timing out and returning
 * a typed outcome instead of throwing. The key is sent in the `Zotero-API-Key`
 * header (never the URL) and is never logged.
 */
async function zoteroGet(
  httpFetch: HttpFetch,
  path: string,
  apiKey: string,
): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await httpFetch(`${ZOTERO_API}${path}`, {
      headers: { "Zotero-API-Version": "3", "Zotero-API-Key": apiKey },
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, message: `Zotero API ${res.status} ${res.statusText}` }
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
    const conn = readConnection(ctx.db)
    if (!conn) return { connected: false }
    return { connected: true, libraryType: conn.libraryType, libraryId: conn.libraryId }
  }),

  /**
   * Validate + persist Zotero credentials. A light probe (one `/items?limit=1`
   * call) confirms the key/library before saving, so an obviously-bad config is
   * rejected up front rather than silently stored. On success the connection is
   * upserted into the singleton settings row.
   */
  connect: publicProcedure
    .input(connectInput)
    .mutation(async ({ ctx, input }): Promise<LibraryStatus> => {
      const conn: ZoteroConnection = {
        apiKey: input.apiKey.trim(),
        libraryType: input.libraryType,
        libraryId: input.libraryId.trim(),
      }
      const probe = await zoteroGet(
        ctx.httpFetch,
        `${libraryBase(conn)}/items?limit=1`,
        conn.apiKey,
      )
      if (!probe.ok) throw new Error(probe.message)

      const now = Date.now()
      ctx.db
        .insert(settings)
        .values({ id: SETTINGS_ROW_ID, zotero: conn, updatedAt: now })
        .onConflictDoUpdate({ target: settings.id, set: { zotero: conn, updatedAt: now } })
        .run()

      return { connected: true, libraryType: conn.libraryType, libraryId: conn.libraryId }
    }),

  /** Clear the stored Zotero connection (the credentials are removed locally). */
  disconnect: publicProcedure.mutation(({ ctx }): LibraryStatus => {
    const now = Date.now()
    ctx.db
      .insert(settings)
      .values({ id: SETTINGS_ROW_ID, zotero: null, updatedAt: now })
      .onConflictDoUpdate({ target: settings.id, set: { zotero: null, updatedAt: now } })
      .run()
    return { connected: false }
  }),

  /**
   * List the top-level items of the connected library, newest-modified first,
   * parsed into UI-ready papers. Returns a typed `not-connected` result (not a
   * throw) when no credentials are stored, and a typed `error` on a failed
   * request, so the tab can render each as a distinct state.
   */
  listItems: publicProcedure
    .input(listItemsInput)
    .query(async ({ ctx, input }): Promise<ListItemsResult> => {
      const conn = readConnection(ctx.db)
      if (!conn) return { ok: false, reason: "not-connected" }

      const limit = input?.limit ?? 50
      const start = input?.start ?? 0
      const path = `${libraryBase(conn)}/items/top?limit=${limit}&start=${start}&sort=dateModified`
      const res = await zoteroGet(ctx.httpFetch, path, conn.apiKey)
      if (!res.ok) return { ok: false, reason: "error", message: res.message }
      return { ok: true, items: parseZoteroItems(res.data) }
    }),

  /**
   * Search Semantic Scholar's Graph API for papers matching a query (no API key
   * required; we keep the field set + page size small to stay polite). Returns a
   * typed error on a failed request instead of throwing.
   */
  searchPapers: publicProcedure
    .input(searchInput)
    .query(async ({ ctx, input }): Promise<SearchResult> => {
      const params = new URLSearchParams({
        query: input.query.trim(),
        fields: SCHOLAR_FIELDS,
        limit: String(SCHOLAR_LIMIT),
      })
      const url = `${SEMANTIC_SCHOLAR_API}/paper/search?${params.toString()}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const res = await ctx.httpFetch(url, { headers: { Accept: "application/json" } })
        if (!res.ok) {
          return { ok: false, message: `Semantic Scholar ${res.status} ${res.statusText}` }
        }
        return { ok: true, papers: parseSemanticScholarPapers(await res.json()) }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Semantic Scholar request failed",
        }
      } finally {
        clearTimeout(timer)
      }
    }),
})
