import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { parseTerminalLinks } from "./links"

describe("parseTerminalLinks", () => {
  // Example-based: pin down the concrete shapes the terminal pane must click.
  test("extracts path, line and column from a colon-delimited reference", () => {
    const [link, ...rest] = parseTerminalLinks("see src/app.ts:12:5 for details")
    expect(rest).toHaveLength(0)
    expect(link).toMatchObject({ path: "src/app.ts", line: 12, column: 5, raw: "src/app.ts:12:5" })
  })

  test("extracts path and line from a line-only reference", () => {
    const [link] = parseTerminalLinks("error at main.rs:40")
    expect(link).toMatchObject({ path: "main.rs", line: 40 })
    expect(link?.column).toBeUndefined()
  })

  test("parses parenthesised line/column forms", () => {
    expect(parseTerminalLinks("App.tsx(18,3)")[0]).toMatchObject({
      path: "App.tsx",
      line: 18,
      column: 3,
    })
    expect(parseTerminalLinks("report.log(7)")[0]).toMatchObject({
      path: "report.log",
      line: 7,
    })
    // Whitespace after the comma is tolerated.
    expect(parseTerminalLinks("a/b.py(9, 21)")[0]).toMatchObject({ line: 9, column: 21 })
  })

  test("matches bare paths that carry a separator or an extension", () => {
    expect(parseTerminalLinks("open ./lib/index.ts now")[0]?.path).toBe("./lib/index.ts")
    expect(parseTerminalLinks("config.yaml changed")[0]?.path).toBe("config.yaml")
  })

  test("finds multiple references in a single line", () => {
    const links = parseTerminalLinks("a/one.ts:1:2 and then b/two.rs:3")
    expect(links.map((l) => l.path)).toEqual(["a/one.ts", "b/two.rs"])
    expect(links.map((l) => l.line)).toEqual([1, 3])
    expect(links.map((l) => l.column)).toEqual([2, undefined])
  })

  test("returns nothing for prose with no path-like tokens", () => {
    expect(parseTerminalLinks("the quick brown fox jumped over")).toEqual([])
    expect(parseTerminalLinks("")).toEqual([])
  })

  test("spans line up with the original text", () => {
    const text = "  utils/format.ts:8:1  "
    const [link] = parseTerminalLinks(text)
    expect(link).toBeDefined()
    if (link) expect(text.slice(link.index, link.index + link.length)).toBe(link.raw)
  })

  // Property-based: invariants that must hold for ALL inputs. fast-check
  // generates many cases and shrinks any failure to a minimal counterexample.
  test("never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        parseTerminalLinks(input)
        return true
      }),
    )
  })

  // A path drawn from a separator/extension-friendly safe charset. Nonempty so a
  // bare token always qualifies; the charset excludes the suffix delimiters
  // (`:`, `(`, `)`, `,`, whitespace) so the path can never absorb the location.
  const safePath = fc
    .stringMatching(/^[A-Za-z0-9/._-]+$/)
    .filter((s) => s.length > 0 && /[A-Za-z0-9]/.test(s))

  test("round-trips a synthesised path:line:column reference", () => {
    fc.assert(
      fc.property(
        safePath,
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (path, line, column) => {
          const links = parseTerminalLinks(`${path}:${line}:${column}`)
          const hit = links.find((l) => l.path === path)
          return hit !== undefined && hit.line === line && hit.column === column
        },
      ),
    )
  })

  test("every match's span re-yields its raw text", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        for (const link of parseTerminalLinks(input)) {
          if (input.slice(link.index, link.index + link.length) !== link.raw) return false
        }
        return true
      }),
    )
  })

  test("any reported line/column is a positive integer", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        for (const link of parseTerminalLinks(input)) {
          if (link.line !== undefined && !(Number.isInteger(link.line) && link.line > 0)) {
            return false
          }
          if (link.column !== undefined && !(Number.isInteger(link.column) && link.column > 0)) {
            return false
          }
        }
        return true
      }),
    )
  })
})
