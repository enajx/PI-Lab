/**
 * Pure parsers + result types for the Library science tab (AGENTS.md "Scope" "Science
 * tabs"). Kept free of tRPC, I/O, and credentials so they are example- and
 * property-testable in isolation: each takes already-decoded JSON (`unknown`)
 * and returns a typed, UI-ready shape, defensively coping with the loose,
 * partially-typed payloads the Zotero Web API actually returns.
 */

/**
 * One paper in a parsed list. Optional fields are omitted (not empty strings) when
 * the source lacks them, so the UI can branch on presence.
 */
export interface LibraryPaper {
  /** Stable id for React keys: the Zotero item key (or a synthesized index fallback). */
  id: string
  title: string
  /** Author display names, in source order; empty when none are listed. */
  authors: string[]
  /** Publication year, when derivable. */
  year?: number
  /** Source item/entry type (e.g. "journalArticle", "conferencePaper"). */
  itemType?: string
  /** DOI, when present. */
  doi?: string
  /** Canonical URL, when present. */
  url?: string
  /** Abstract, when present (Zotero's `abstractNote`, when set). */
  abstract?: string
}

/**
 * One Zotero collection in a parsed list. `itemCount`/`subcollectionCount` come from
 * the API's `meta` block so the browser can show counts and whether to offer drill-in.
 */
export interface LibraryCollection {
  /** Stable Zotero collection key (used in the items/subcollections paths). */
  key: string
  name: string
  /** Top-level items directly in this collection (from `meta.numItems`). */
  itemCount: number
  /** Number of immediate subcollections (from `meta.numCollections`). */
  subcollectionCount: number
}

/**
 * Parse a Zotero `/collections` response into {@link LibraryCollection}s. The API
 * returns an array of `{ key, data: { name }, meta: { numItems, numCollections } }`;
 * a non-array payload parses to an empty list rather than throwing.
 */
export function parseZoteroCollections(payload: unknown): LibraryCollection[] {
  if (!Array.isArray(payload)) return []
  return payload.map((row, index) => {
    const r = (row ?? {}) as {
      key?: string
      data?: { name?: string }
      meta?: { numItems?: number; numCollections?: number }
    }
    return {
      key: nonEmpty(r.key) ?? `collection-${index}`,
      name: nonEmpty(r.data?.name) ?? "(untitled collection)",
      itemCount: typeof r.meta?.numItems === "number" ? r.meta.numItems : 0,
      subcollectionCount: typeof r.meta?.numCollections === "number" ? r.meta.numCollections : 0,
    }
  })
}

/** A single Zotero creator entry (either a structured name or a one-field name). */
interface ZoteroCreator {
  firstName?: string
  lastName?: string
  name?: string
}

/** Display name for one Zotero creator (`name`, else `first last`), trimmed. */
function creatorName(creator: ZoteroCreator): string {
  if (typeof creator.name === "string" && creator.name.trim()) return creator.name.trim()
  return [creator.firstName, creator.lastName]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim())
    .join(" ")
}

/** Pull a 4-digit year out of a free-form Zotero `date` string, if any. */
function yearFromDate(date: unknown): number | undefined {
  if (typeof date !== "string") return undefined
  const match = date.match(/\d{4}/)
  if (!match) return undefined
  const year = Number.parseInt(match[0], 10)
  return Number.isFinite(year) ? year : undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Parse a Zotero `/items` (top-level) response into {@link LibraryPaper}s. The
 * API returns an array of `{ key, data: { title, creators, date, itemType, DOI,
 * url } }`; anything missing degrades gracefully (untitled, no authors, etc.).
 * A non-array payload (or null) parses to an empty list rather than throwing.
 */
export function parseZoteroItems(payload: unknown): LibraryPaper[] {
  if (!Array.isArray(payload)) return []
  return payload.map((row, index) => {
    const r = (row ?? {}) as {
      key?: string
      data?: {
        title?: string
        itemType?: string
        date?: string
        DOI?: string
        url?: string
        creators?: ZoteroCreator[]
        abstractNote?: string
      }
    }
    const data = r.data ?? {}
    const authors = (data.creators ?? []).map(creatorName).filter((name) => name.length > 0)
    return {
      id: nonEmpty(r.key) ?? `zotero-${index}`,
      title: nonEmpty(data.title) ?? "(untitled)",
      authors,
      year: yearFromDate(data.date),
      itemType: nonEmpty(data.itemType),
      doi: nonEmpty(data.DOI),
      url: nonEmpty(data.url),
      abstract: nonEmpty(data.abstractNote),
    }
  })
}
