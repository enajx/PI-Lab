/**
 * Pure, renderer-safe fuzzy matcher for file/path and list search.
 *
 * Shared by both the Electron main process (workspace file search) and the
 * renderer (command palette, highlighting), so it has **no** Node or DOM
 * dependencies and never throws for any pair of strings.
 *
 * The single load-bearing invariant — relied on by callers and the property
 * tests — is:
 *
 *   `fuzzyMatch(query, target) !== null`  **iff**  `query` is a
 *   case-insensitive subsequence of `target`, **or** `query` is empty.
 *
 * "Subsequence" means every character of `query`, in order (but not
 * necessarily contiguous), can be found in `target`. The score is otherwise
 * arbitrary in magnitude — only the match/no-match boundary carries cross-call
 * meaning, while larger scores rank a target higher among matches.
 *
 * The **empty query** is a match with score `0` and no positions; a file picker
 * decides separately whether "match everything" or "match nothing" is the right
 * call-site behaviour for an empty query.
 */

/** Bonus for a query char that immediately follows the previous match. */
const CONTIGUOUS_BONUS = 8
/** Bonus for a query char that lands at the very start of the target. */
const START_BONUS = 12
/** Bonus for a query char that begins a path/word segment (after a boundary). */
const SEGMENT_START_BONUS = 10
/** Base reward for matching a query char at all. */
const MATCH_BASE = 1
/** Characters that mark the start of a new "segment" within a path. */
const BOUNDARY_CHARS = new Set(["/", "\\", "_", "-", ".", " "])

/** A successful fuzzy match: its ranking score and the matched char positions. */
export interface FuzzyMatch {
  /** Higher ranks better; `0` for the empty query. Never negative. */
  score: number
  /**
   * Indices into `target` of the char chosen for each query char, in ascending
   * order — exactly one per query char (empty for the empty query).
   */
  positions: number[]
}

/**
 * Match `query` against `target`, returning the ranking `score` and the matched
 * char `positions`, or `null` when `query` is not a case-insensitive
 * subsequence of `target`.
 *
 * The empty query is a match with `{ score: 0, positions: [] }`. The score
 * rewards matches that are more contiguous and that begin at the start of the
 * string or of a path segment, using the same greedy left-to-right scan as a
 * fzf-style matcher.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, positions: [] }
  if (target.length === 0 || query.length > target.length) return null

  const q = query.toLowerCase()
  const t = target.toLowerCase()

  let score = 0
  let qi = 0
  // Index in `target` of the previous matched char, or -2 so the first match is
  // never mistaken for "contiguous with the previous one".
  let prevMatch = -2
  const positions: number[] = []

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue

    score += MATCH_BASE
    if (ti === 0) {
      score += START_BONUS
    } else if (BOUNDARY_CHARS.has(t[ti - 1] ?? "")) {
      score += SEGMENT_START_BONUS
    }
    if (ti === prevMatch + 1) {
      score += CONTIGUOUS_BONUS
    }

    positions.push(ti)
    prevMatch = ti
    qi++
  }

  // If we ran out of target before consuming all of the query, it was not a
  // subsequence — no match.
  return qi === q.length ? { score, positions } : null
}

/**
 * Score how well `query` matches `target`, returning `0` when `query` is not a
 * case-insensitive subsequence of `target` (including the empty-query case) and
 * a positive number otherwise. Equivalent to `fuzzyMatch(query, target)?.score`
 * with no-match collapsed to `0`; preserves the ranking of {@link fuzzyMatch}.
 */
export function fuzzyScore(query: string, target: string): number {
  return fuzzyMatch(query, target)?.score ?? 0
}

/** One run of consecutive matched or unmatched characters from a target. */
export interface HighlightSegment {
  /** The slice of the original text covered by this run. */
  text: string
  /** Whether every char in this run is a matched (highlighted) position. */
  matched: boolean
}

/**
 * Split `text` into consecutive runs of matched / unmatched characters,
 * covering the whole string (the concatenation of every segment's `text` equals
 * `text`). Adjacent chars of the same kind are merged into one segment.
 * Positions outside `[0, text.length)` — and non-integers — are ignored.
 */
export function highlightSegments(text: string, positions: number[]): HighlightSegment[] {
  const matched = new Set<number>()
  for (const p of positions) {
    if (Number.isInteger(p) && p >= 0 && p < text.length) matched.add(p)
  }

  const segments: HighlightSegment[] = []
  let current: HighlightSegment | undefined
  for (let i = 0; i < text.length; i++) {
    const isMatch = matched.has(i)
    if (current && current.matched === isMatch) {
      current.text += text.charAt(i)
    } else {
      current = { text: text.charAt(i), matched: isMatch }
      segments.push(current)
    }
  }
  return segments
}
