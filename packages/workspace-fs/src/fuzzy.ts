/**
 * Pure fuzzy matcher for file/path search.
 *
 * The single load-bearing invariant — relied on by callers and the property
 * tests — is:
 *
 *   `fuzzyScore(query, candidate) > 0`  **iff**  `query` is a case-insensitive
 *   subsequence of `candidate`.
 *
 * "Subsequence" means every character of `query`, in order (but not
 * necessarily contiguous), can be found in `candidate`. The score is otherwise
 * arbitrary in magnitude — only its sign carries meaning across the boundary,
 * while larger values rank a candidate higher among matches.
 *
 * The **empty query** is defined to score `0` (no match). A file picker treats
 * an empty query as "match everything" at the call site, not here — keeping
 * this function's match/no-match boundary purely about subsequence membership.
 *
 * The function is total and deterministic: it never throws for any pair of
 * strings, and identical inputs always yield an identical number.
 */

/** Bonus for a query char that immediately follows the previous match. */
const CONTIGUOUS_BONUS = 8
/** Bonus for a query char that lands at the very start of the candidate. */
const START_BONUS = 12
/** Bonus for a query char that begins a path/word segment (after a boundary). */
const SEGMENT_START_BONUS = 10
/** Base reward for matching a query char at all. */
const MATCH_BASE = 1
/** Characters that mark the start of a new "segment" within a path. */
const BOUNDARY_CHARS = new Set(["/", "\\", "_", "-", ".", " "])

/**
 * Score how well `query` matches `candidate`. Returns `0` when `query` is not a
 * case-insensitive subsequence of `candidate` (including the empty-query case),
 * and a positive number otherwise — higher for matches that are more
 * contiguous and that begin at the start of the string or of a path segment.
 */
export function fuzzyScore(query: string, candidate: string): number {
  if (query.length === 0) return 0
  if (candidate.length > 0 && query.length > candidate.length) return 0

  const q = query.toLowerCase()
  const c = candidate.toLowerCase()

  let score = 0
  let qi = 0
  // Index in `candidate` of the previous matched char, or -2 so the first
  // match is never mistaken for "contiguous with the previous one".
  let prevMatch = -2

  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] !== q[qi]) continue

    score += MATCH_BASE
    if (ci === 0) {
      score += START_BONUS
    } else if (BOUNDARY_CHARS.has(c[ci - 1] ?? "")) {
      score += SEGMENT_START_BONUS
    }
    if (ci === prevMatch + 1) {
      score += CONTIGUOUS_BONUS
    }

    prevMatch = ci
    qi++
  }

  // Only a positive score is a real match; if we ran out of candidate before
  // consuming all of the query, it was not a subsequence.
  return qi === q.length ? score : 0
}
