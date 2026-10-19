// Unit + property tests for the ruff JSON parser. It's a pure
// transform over loose JSON text, so it gets example tests against the *real*
// `ruff check --output-format json` shape plus fast-check properties for totality
// (never throws, always well-formed) on arbitrary input.
import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { parseRuffJson } from "./parseRuff"
import type { Diagnostic } from "./types"

// A real ruff JSON entry (captured from `uvx ruff check … --output-format json`).
const RUFF_FIXTURE = JSON.stringify([
  {
    cell: null,
    code: "F401",
    end_location: { column: 10, row: 1 },
    filename: "/tmp/diag_probe.py",
    fix: { applicability: "safe", edits: [], message: "Remove unused import: `os`" },
    location: { column: 8, row: 1 },
    message: "`os` imported but unused",
    name: "unused-import",
    noqa_row: 1,
    severity: "error",
    url: "https://docs.astral.sh/ruff/rules/unused-import",
  },
  {
    cell: null,
    code: "F841",
    end_location: { column: 6, row: 3 },
    filename: "/tmp/diag_probe.py",
    fix: null,
    location: { column: 5, row: 3 },
    message: "Local variable `y` is assigned to but never used",
    name: "unused-variable",
    noqa_row: 3,
    severity: "error",
    url: "https://docs.astral.sh/ruff/rules/unused-variable",
  },
])

describe("parseRuffJson — real-shaped output", () => {
  test("maps each entry into a normalized diagnostic with code + range", () => {
    const diagnostics = parseRuffJson(RUFF_FIXTURE)
    expect(diagnostics).toEqual<Diagnostic[]>([
      {
        source: "ruff",
        severity: "error",
        line: 1,
        column: 8,
        endLine: 1,
        endColumn: 10,
        message: "`os` imported but unused",
        code: "F401",
      },
      {
        source: "ruff",
        severity: "error",
        line: 3,
        column: 5,
        endLine: 3,
        endColumn: 6,
        message: "Local variable `y` is assigned to but never used",
        code: "F841",
      },
    ])
  })

  test("an empty result array parses to no diagnostics", () => {
    expect(parseRuffJson("[]")).toEqual([])
  })

  test("maps explicit warning / info severities", () => {
    const out = parseRuffJson(
      JSON.stringify([
        { code: "W", location: { row: 2, column: 1 }, message: "warn", severity: "warning" },
        { code: "I", location: { row: 3, column: 1 }, message: "note", severity: "info" },
      ]),
    )
    expect(out.map((d) => d.severity)).toEqual(["warning", "info"])
  })

  test("an unknown severity degrades to warning, not error", () => {
    const out = parseRuffJson(
      JSON.stringify([{ location: { row: 1, column: 1 }, message: "x", severity: "weird" }]),
    )
    expect(out[0]?.severity).toBe("warning")
  })
})

describe("parseRuffJson — defensive / graceful", () => {
  test.each([
    ["empty string", ""],
    ["whitespace", "   \n  "],
    ["invalid JSON", "{not json"],
    ["a JSON object (not an array)", '{"foo":1}'],
    ["a JSON scalar", "42"],
    ["null", "null"],
  ])("returns [] for %s", (_label, input) => {
    expect(parseRuffJson(input)).toEqual([])
  })

  test("skips entries missing a usable position", () => {
    const out = parseRuffJson(
      JSON.stringify([
        { code: "A", message: "no location" },
        { code: "B", location: { row: 0, column: 1 }, message: "row not positive" },
        { code: "C", location: { row: 5, column: 2 }, message: "ok" },
      ]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ code: "C", line: 5, column: 2 })
  })

  test("omits endLine/endColumn when there is no end_location", () => {
    const [d] = parseRuffJson(
      JSON.stringify([{ code: "A", location: { row: 1, column: 1 }, message: "x" }]),
    )
    expect(d).not.toHaveProperty("endLine")
    expect(d).not.toHaveProperty("endColumn")
  })
})

describe("parseRuffJson — property: total + well-formed", () => {
  test("never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => parseRuffJson(s)).not.toThrow()
      }),
    )
  })

  test("never throws on arbitrary JSON values, and output is well-formed", () => {
    fc.assert(
      fc.property(fc.json(), (jsonText) => {
        const out = parseRuffJson(jsonText)
        expect(Array.isArray(out)).toBe(true)
        for (const d of out) assertWellFormed(d)
      }),
    )
  })

  test("survives arbitrary arrays of partial entries", () => {
    const entry = fc.record(
      {
        code: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
        message: fc.oneof(fc.string(), fc.constant(null)),
        severity: fc.oneof(fc.string(), fc.constant(undefined)),
        location: fc.oneof(
          fc.record({ row: fc.integer(), column: fc.integer() }),
          fc.constant(null),
          fc.constant(undefined),
        ),
        end_location: fc.oneof(
          fc.record({ row: fc.integer(), column: fc.integer() }),
          fc.constant(undefined),
        ),
      },
      { requiredKeys: [] },
    )
    fc.assert(
      fc.property(fc.array(fc.oneof(entry, fc.anything())), (entries) => {
        const out = parseRuffJson(JSON.stringify(entries))
        for (const d of out) assertWellFormed(d)
      }),
    )
  })
})

/** Every emitted diagnostic must satisfy the normalized contract. */
export function assertWellFormed(d: Diagnostic): void {
  expect(["ty", "pyrefly", "ruff"]).toContain(d.source)
  expect(["error", "warning", "info"]).toContain(d.severity)
  expect(Number.isInteger(d.line) && d.line >= 1).toBe(true)
  expect(Number.isInteger(d.column) && d.column >= 1).toBe(true)
  expect(typeof d.message).toBe("string")
  if (d.endLine !== undefined) expect(Number.isInteger(d.endLine) && d.endLine >= 1).toBe(true)
  if (d.endColumn !== undefined) {
    expect(Number.isInteger(d.endColumn) && d.endColumn >= 1).toBe(true)
  }
  if (d.code !== undefined) expect(typeof d.code).toBe("string")
}
