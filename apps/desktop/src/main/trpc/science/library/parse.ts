/**
 * Pure parsers + result types for the Library science tab (AGENTS.md §1 "Science
 * tabs"). Kept free of tRPC, I/O, and credentials so they are example- and
 * property-testable in isolation: each takes already-decoded JSON (`unknown`)
 * and returns a typed, UI-ready shape, defensively coping with the loose,
 * partially-typed payloads the Zotero Web API and Semantic Scholar Graph API
 * actually return.
 */

/**
 * One paper in a parsed list, normalized across both sources so the UI renders a
 * single card shape. Optional fields are omitted (not empty strings) when the
 * source lacks them, so the UI can branch on presence.
 */
export interface LibraryPaper {
  /** Stable id for React keys: Zotero item key, or the S2 paperId / DOI / index. */
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
  /** Abstract, when present (Semantic Scholar provides it; Zotero usually not). */
  abstract?: string
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

/** A single Semantic Scholar author sub-object. */
interface S2Author {
  name?: string
}

/**
 * Parse a Semantic Scholar `/paper/search` response into {@link LibraryPaper}s.
 * The API returns `{ total, data: [{ paperId, title, year, authors, abstract,
 * externalIds: { DOI, ... }, url }] }`. A missing/!-array `data` parses to an
 * empty list. `itemType` is fixed to "paper" since S2 doesn't model one.
 */
export function parseSemanticScholarPapers(payload: unknown): LibraryPaper[] {
  const rows = (payload as { data?: unknown })?.data
  if (!Array.isArray(rows)) return []
  return rows.map((row, index) => {
    const r = (row ?? {}) as {
      paperId?: string
      title?: string
      year?: number
      abstract?: string
      url?: string
      authors?: S2Author[]
      externalIds?: { DOI?: string }
    }
    const authors = (r.authors ?? [])
      .map((author) => nonEmpty(author?.name))
      .filter((name): name is string => Boolean(name))
    const doi = nonEmpty(r.externalIds?.DOI)
    return {
      id: nonEmpty(r.paperId) ?? doi ?? `s2-${index}`,
      title: nonEmpty(r.title) ?? "(untitled)",
      authors,
      year: typeof r.year === "number" && Number.isFinite(r.year) ? r.year : undefined,
      itemType: "paper",
      doi,
      url: nonEmpty(r.url),
      abstract: nonEmpty(r.abstract),
    }
  })
}
