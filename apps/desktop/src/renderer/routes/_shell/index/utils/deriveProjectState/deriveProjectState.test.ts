import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { deriveProjectState, type ProjectState } from "./deriveProjectState"

const STATES: ProjectState[] = ["idle", "active", "attention"]

describe("deriveProjectState", () => {
  // Example-based: pin down the concrete, human-meaningful behaviour.
  test("idle when nothing is happening", () => {
    expect(deriveProjectState({ sessionCount: 0, changeCount: 0, attentionCount: 0 })).toBe("idle")
  })

  test("active when there are open sessions", () => {
    expect(deriveProjectState({ sessionCount: 2, changeCount: 0, attentionCount: 0 })).toBe(
      "active",
    )
  })

  test("active when the working tree has changes but no sessions", () => {
    expect(deriveProjectState({ sessionCount: 0, changeCount: 5, attentionCount: 0 })).toBe(
      "active",
    )
  })

  test("attention when something flags a human is needed", () => {
    expect(deriveProjectState({ sessionCount: 0, changeCount: 0, attentionCount: 1 })).toBe(
      "attention",
    )
  })

  test("attention outranks active", () => {
    expect(deriveProjectState({ sessionCount: 9, changeCount: 9, attentionCount: 1 })).toBe(
      "attention",
    )
  })

  // Property-based: invariants that must hold for ALL numeric inputs. fast-check
  // generates hundreds of cases (incl. negatives, NaN, ±Infinity) and shrinks any
  // failure to a minimal counterexample.
  const anyInput = fc.record({
    sessionCount: fc.double(),
    changeCount: fc.double(),
    attentionCount: fc.double(),
  })

  test("is total — never throws for any numeric input", () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        deriveProjectState(input)
      }),
    )
  })

  test("output is always a member of the state enum", () => {
    fc.assert(fc.property(anyInput, (input) => STATES.includes(deriveProjectState(input))))
  })

  test("is deterministic — same input maps to the same state", () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        // Call on two distinct copies so the comparison is genuinely repeated
        // evaluation, not a textual self-compare.
        const a = deriveProjectState({ ...input })
        const b = deriveProjectState({ ...input })
        return a === b
      }),
    )
  })

  test("respects priority: attention beats active beats idle", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 50 }),
        fc.nat({ max: 50 }),
        fc.nat({ max: 50 }),
        (sessionCount, changeCount, attentionCount) => {
          const state = deriveProjectState({ sessionCount, changeCount, attentionCount })
          if (attentionCount > 0) return state === "attention"
          if (sessionCount > 0 || changeCount > 0) return state === "active"
          return state === "idle"
        },
      ),
    )
  })
})
