import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { slugify } from "./slugify"

describe("slugify", () => {
  // Example-based: pin down the concrete, human-meaningful behaviour.
  test("normalizes punctuation and case", () => {
    expect(slugify("Hello, World!")).toBe("hello-world")
  })
  test("folds accented Latin to base letters", () => {
    expect(slugify("Über Café")).toBe("uber-cafe")
  })
  test("collapses whitespace and separator runs", () => {
    expect(slugify("  feat/new   thing  ")).toBe("feat-new-thing")
  })
  test("falls back when the slug is empty", () => {
    expect(slugify("")).toBe("untitled")
    expect(slugify("!!!")).toBe("untitled")
    expect(slugify("   ", { fallback: "ws" })).toBe("ws")
  })

  // Property-based: invariants that must hold for ALL string inputs. fast-check
  // generates hundreds of cases and shrinks any failure to a minimal example.
  test("output always has a clean slug shape", () => {
    fc.assert(
      fc.property(fc.string(), (input) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slugify(input))),
    )
  })
  test("is idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const once = slugify(input)
        return slugify(once) === once
      }),
    )
  })
  test("never exceeds the max length", () => {
    fc.assert(fc.property(fc.string(), (input) => slugify(input).length <= 60))
  })
})
