import { relative } from "node:path"
import { fuzzyScore } from "@pi-lab/shared"
import type { WalkOptions } from "./fs"
import { walkWorkspace } from "./walk"

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
const QUICK_OPEN_OUTPUT_DIRS = ["build", "out", "dist", ".next"] as const

/** Ranked matches with any expected paths skipped during traversal. */
export interface SearchResult {
  hits: SearchHit[]
  partial: boolean
  skipped: string[]
}

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
): Promise<SearchResult> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return { hits: [], partial: false, skipped: [] }

  const resultLimit = Math.max(0, opts.limit ?? DEFAULT_RESULT_LIMIT)
  const hits: SearchHit[] = []
  const walk = await walkWorkspace(
    root,
    { ignore: [...QUICK_OPEN_OUTPUT_DIRS, ...(opts.ignore ?? [])], maxDepth: opts.maxDepth },
    (entry) => {
      if (entry.kind !== "file") return "continue"
      const path = entry.path
      const rel = toForwardSlashes(relative(root, path))
      const score = fuzzyScore(trimmed, rel)
      if (score <= 0 || resultLimit === 0) return "continue"
      const hit = { path, score }
      const worst = hits[hits.length - 1]
      if (hits.length === resultLimit && worst && compareHits(hit, worst) >= 0) {
        return "continue"
      }
      const index = hits.findIndex((existing) => compareHits(hit, existing) < 0)
      hits.splice(index < 0 ? hits.length : index, 0, hit)
      if (hits.length > resultLimit) hits.pop()
      return "continue"
    },
  )

  return { hits, partial: walk.partial, skipped: walk.skipped }
}

function compareHits(a: SearchHit, b: SearchHit): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.path.length !== b.path.length) return a.path.length - b.path.length
  return a.path.localeCompare(b.path)
}

function toForwardSlashes(p: string): string {
  return p.replaceAll("\\", "/")
}
