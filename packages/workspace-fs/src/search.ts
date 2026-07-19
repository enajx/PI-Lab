import { relative } from "node:path"
import { fuzzyScore } from "@pi-lab/shared"
import { type WalkOptions, walkFiles } from "./fs"

/** A single ranked search hit. */
export interface SearchHit {
  /** Absolute path to the matched file. */
  path: string
  /** Fuzzy score for the match (always > 0). */
  score: number
}

/** Options controlling a workspace file search. */
export interface SearchOptions extends WalkOptions {
  /** Maximum number of hits to return (default 50). */
  limit?: number
}

const DEFAULT_RESULT_LIMIT = 50

/**
 * Walk `root`, fuzzy-score every file against `query`, and return the best
 * matches highest-score-first. Scoring is run against each file's path
 * **relative to `root`** (with forward slashes), so a query can match against
 * the directory structure, not just the basename. Ties break on the shorter
 * path then alphabetically for deterministic ordering.
 *
 * An empty/whitespace-only query returns no hits.
 */
export async function searchFiles(
  root: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []

  const resultLimit = opts.limit ?? DEFAULT_RESULT_LIMIT
  // Walk without the result limit — that caps *files scanned*, not *hits*.
  const { limit: _ignored, ...walkOpts } = opts
  const files = await walkFiles(root, walkOpts satisfies WalkOptions)

  const hits: SearchHit[] = []
  for (const path of files) {
    const rel = toForwardSlashes(relative(root, path))
    const score = fuzzyScore(trimmed, rel)
    if (score > 0) hits.push({ path, score })
  }

  hits.sort(compareHits)
  return hits.slice(0, resultLimit)
}

function compareHits(a: SearchHit, b: SearchHit): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.path.length !== b.path.length) return a.path.length - b.path.length
  return a.path.localeCompare(b.path)
}

function toForwardSlashes(p: string): string {
  return p.replaceAll("\\", "/")
}
