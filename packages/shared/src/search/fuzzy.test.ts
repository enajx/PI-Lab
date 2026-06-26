import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { fuzzyMatch, fuzzyScore, highlightSegments } from "./fuzzy"

/** Independent reference: is `query` a case-insensitive subsequence of `target`? */
function isCaseInsensitiveSubsequence(query: string, target: string): boolean {
  if (query.length === 0) return true // the empty query is a subsequence of everything
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++
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
  test("empty query scores 0", () => {
    expect(fuzzyScore("", "anything")).toBe(0)
    expect(fuzzyScore("", "")).toBe(0)
  })
  test("non-subsequence scores 0", () => {
    expect(fuzzyScore("xyz", "button")).toBe(0)
    expect(fuzzyScore("longerthancandidate", "abc")).toBe(0)
  })

  // Property-based: the core invariant and total/deterministic guarantees.
  test("score > 0 IFF query is a non-empty case-insensitive subsequence of target", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (query, target) => {
        const positive = fuzzyScore(query, target) > 0
        return positive === (query.length > 0 && isCaseInsensitiveSubsequence(query, target))
      }),
    )
  })

  test("is deterministic (same inputs => same score)", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (query, target) => {
        const first = fuzzyScore(query, target)
        const second = fuzzyScore(`${query}`, `${target}`)
        return first === second
      }),
    )
  })

  test("never throws on arbitrary strings and returns a finite, non-negative number", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (query, target) => {
        const score = fuzzyScore(query, target)
        return Number.isFinite(score) && score >= 0
      }),
    )
  })
})

describe("fuzzyMatch", () => {
  test("returns null for a non-subsequence", () => {
    expect(fuzzyMatch("xyz", "button")).toBeNull()
    expect(fuzzyMatch("ab", "")).toBeNull()
  })
  test("empty query is a match with score 0 and no positions", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] })
    expect(fuzzyMatch("", "")).toEqual({ score: 0, positions: [] })
  })
  test("records the position of each matched char", () => {
    // "bt" in "button": greedy scan takes 'b' at 0, then the first 't' at 2.
    expect(fuzzyMatch("bt", "button")).toEqual({
      score: expect.any(Number),
      positions: [0, 2],
    })
  })
  test("score matches fuzzyScore for a real match", () => {
    const m = fuzzyMatch("but", "button.tsx")
    expect(m).not.toBeNull()
    expect(m?.score).toBe(fuzzyScore("but", "button.tsx"))
  })

  test("non-null IFF query is a non-empty subsequence (matching the score boundary)", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (query, target) => {
        const matched = fuzzyMatch(query, target) !== null
        const isMatch = query.length === 0 || isCaseInsensitiveSubsequence(query, target)
        return matched === isMatch
      }),
    )
  })

  test("positions are in range, strictly ascending, and one per query char", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (query, target) => {
        const m = fuzzyMatch(query, target)
        if (m === null) return true
        const { positions } = m
        if (positions.length !== query.length) return false
        for (let i = 0; i < positions.length; i++) {
          const p = positions[i] ?? Number.NaN
          if (!Number.isInteger(p) || p < 0 || p >= target.length) return false
          if (i > 0 && p <= (positions[i - 1] ?? Number.NaN)) return false
        }
        return true
      }),
    )
  })

  test("each matched position holds the right (case-insensitive) query char", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (query, target) => {
        const m = fuzzyMatch(query, target)
        if (m === null) return true
        const q = query.toLowerCase()
        const t = target.toLowerCase()
        return m.positions.every((p, i) => t[p] === q[i])
      }),
    )
  })

  test("a known subsequence (derived from target) always matches", () => {
    fc.assert(
      fc.property(
        // Build a target string, then keep a sub-selection of its chars in order:
        // by construction that is a subsequence and must match.
        fc
          .string({ minLength: 1 })
          .chain((target) =>
            fc
              .array(fc.boolean(), { minLength: target.length, maxLength: target.length })
              .map((keep) => ({ target, keep })),
          ),
        ({ target, keep }) => {
          let query = ""
          for (let i = 0; i < target.length; i++) {
            if (keep[i]) query += target[i]
          }
          fc.pre(query.length > 0)
          return fuzzyMatch(query, target) !== null
        },
      ),
    )
  })
})

describe("highlightSegments", () => {
  test("splits text into matched / unmatched runs covering the whole string", () => {
    // Highlight indices 0 and 3 of "button" (the 'b' and the second 't').
    expect(highlightSegments("button", [0, 3])).toEqual([
      { text: "b", matched: true },
      { text: "ut", matched: false },
      { text: "t", matched: true },
      { text: "on", matched: false },
    ])
  })
  test("merges adjacent matched chars into a single run", () => {
    expect(highlightSegments("button", [0, 1, 2])).toEqual([
      { text: "but", matched: true },
      { text: "ton", matched: false },
    ])
  })
  test("empty text yields no segments", () => {
    expect(highlightSegments("", [0, 1])).toEqual([])
  })
  test("ignores out-of-range and non-integer positions", () => {
    expect(highlightSegments("abc", [-1, 1, 3, 99, 1.5])).toEqual([
      { text: "a", matched: false },
      { text: "b", matched: true },
      { text: "c", matched: false },
    ])
  })

  test("segment texts always concatenate back to the original text", () => {
    fc.assert(
      fc.property(fc.string(), fc.array(fc.integer()), (text, positions) => {
        const joined = highlightSegments(text, positions)
          .map((s) => s.text)
          .join("")
        return joined === text
      }),
    )
  })

  test("marks exactly the in-range positions as matched", () => {
    fc.assert(
      fc.property(fc.string(), fc.array(fc.integer()), (text, positions) => {
        const inRange = new Set(
          positions.filter((p) => Number.isInteger(p) && p >= 0 && p < text.length),
        )
        const segments = highlightSegments(text, positions)
        // Flatten segments back to a per-char matched flag and compare. Iterate
        // by UTF-16 code unit (not code point) to stay aligned with the indices.
        let i = 0
        for (const seg of segments) {
          for (let k = 0; k < seg.text.length; k++) {
            if (seg.matched !== inRange.has(i)) return false
            i++
          }
        }
        return i === text.length
      }),
    )
  })

  test("highlights exactly the positions a real match reports", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (query, target) => {
        const m = fuzzyMatch(query, target)
        if (m === null) return true
        const segments = highlightSegments(target, m.positions)
        const matchedIdx = new Set(m.positions)
        let i = 0
        for (const seg of segments) {
          for (let k = 0; k < seg.text.length; k++) {
            if (seg.matched !== matchedIdx.has(i)) return false
            i++
          }
        }
        return i === target.length
      }),
    )
  })
})
