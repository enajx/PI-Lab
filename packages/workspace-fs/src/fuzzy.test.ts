import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { fuzzyScore } from "./fuzzy"

/** Independent reference: is `query` a case-insensitive subsequence of `candidate`? */
function isCaseInsensitiveSubsequence(query: string, candidate: string): boolean {
  if (query.length === 0) return false // matches fuzzyScore's documented empty-query rule
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()
  let qi = 0
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) qi++
  }
  return qi === q.length
}

describe("fuzzyScore", () => {
  // Example-based: pin down concrete, human-meaningful behaviour.
  test("scores a contiguous start-of-string match highest", () => {
    expect(fuzzyScore("but", "button.tsx")).toBeGreaterThan(fuzzyScore("but", "rebuttal.ts"))
  })
  test("is case-insensitive", () => {
    expect(fuzzyScore("BTN", "btn.ts")).toBeGreaterThan(0)
  })
  test("rewards a match at a segment boundary", () => {
    // "i" after the "/" boundary should beat "i" buried mid-word.
    expect(fuzzyScore("i", "src/index")).toBeGreaterThan(fuzzyScore("i", "main"))
  })
  test("empty query is defined to score 0", () => {
    expect(fuzzyScore("", "anything")).toBe(0)
    expect(fuzzyScore("", "")).toBe(0)
  })
  test("non-subsequence scores 0", () => {
    expect(fuzzyScore("xyz", "button")).toBe(0)
    expect(fuzzyScore("longerthancandidate", "abc")).toBe(0)
  })

  // Property-based: the core invariant and total/deterministic guarantees.
  test("score > 0 IFF query is a case-insensitive subsequence of candidate", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (query, candidate) => {
        const positive = fuzzyScore(query, candidate) > 0
        return positive === isCaseInsensitiveSubsequence(query, candidate)
      }),
    )
  })

  test("a known subsequence (derived from candidate) always scores > 0", () => {
    fc.assert(
      fc.property(
        // Build a candidate string, then keep a sub-selection of its chars in
        // order: by construction that is a subsequence and must score positive.
        fc
          .string({ minLength: 1 })
          .chain((candidate) =>
            fc
              .array(fc.boolean(), { minLength: candidate.length, maxLength: candidate.length })
              .map((keep) => ({ candidate, keep })),
          ),
        ({ candidate, keep }) => {
          // Iterate UTF-16 code units to match the mask length and the scorer.
          let query = ""
          for (let i = 0; i < candidate.length; i++) {
            if (keep[i]) query += candidate[i]
          }
          fc.pre(query.length > 0)
          return fuzzyScore(query, candidate) > 0
        },
      ),
    )
  })

  test("is deterministic (same inputs => same score)", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (query, candidate) => {
        const first = fuzzyScore(query, candidate)
        const second = fuzzyScore(`${query}`, `${candidate}`)
        return first === second
      }),
    )
  })

  test("never throws on arbitrary strings and returns a finite number", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (query, candidate) => {
        const score = fuzzyScore(query, candidate)
        return Number.isFinite(score) && score >= 0
      }),
    )
  })
})
