// Unit + property tests for the pyrefly JSON parser (md/engineering/testing-and-build.md). Pure
// transform over loose JSON, so example tests against the real `pyrefly check
// --output-format json` shape plus fast-check totality properties.
import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { parsePyreflyJson } from "./parsePyrefly"
import { assertWellFormed } from "./parseRuff.test"
import type { Diagnostic } from "./types"

// Real `pyrefly check --output-format json` stdout (the INFO summary goes to
// stderr, so captured stdout is a clean JSON object).
const PYREFLY_FIXTURE = JSON.stringify({
  errors: [
    {
      line: 4,
      column: 16,
      stop_line: 4,
      stop_column: 30,
      path: "diag_probe.py",
      code: -2,
      name: "unknown-name",
      description: "Could not find name `undefined_name`",
      concise_description: "Could not find name `undefined_name`",
      severity: "error",
    },
  ],
})

describe("parsePyreflyJson — real-shaped output", () => {
  test("maps each error into a normalized diagnostic with range + code", () => {
    expect(parsePyreflyJson(PYREFLY_FIXTURE)).toEqual<Diagnostic[]>([
      {
        source: "pyrefly",
        severity: "error",
        line: 4,
        column: 16,
        endLine: 4,
        endColumn: 30,
        message: "Could not find name `undefined_name`",
        code: "unknown-name",
      },
    ])
  })

  test("an empty errors array parses to no diagnostics", () => {
    expect(parsePyreflyJson('{"errors":[]}')).toEqual([])
  })

  test("falls back to concise_description when description is missing", () => {
    const out = parsePyreflyJson(
      JSON.stringify({
        errors: [
          { line: 1, column: 1, name: "x", concise_description: "short", severity: "error" },
        ],
      }),
    )
    expect(out[0]?.message).toBe("short")
  })

  test("maps warning / info severities", () => {
    const out = parsePyreflyJson(
      JSON.stringify({
        errors: [
          { line: 1, column: 1, severity: "warn", description: "w" },
          { line: 2, column: 1, severity: "info", description: "i" },
        ],
      }),
    )
    expect(out.map((d) => d.severity)).toEqual(["warning", "info"])
  })
})

describe("parsePyreflyJson — defensive / graceful", () => {
  test.each([
    ["empty string", ""],
    ["whitespace", "  \n "],
    ["invalid JSON", "{bad"],
    ["an array root", "[]"],
    ["object without errors", '{"foo":1}'],
    ["errors is not an array", '{"errors":"nope"}'],
    ["null", "null"],
  ])("returns [] for %s", (_label, input) => {
    expect(parsePyreflyJson(input)).toEqual([])
  })

  test("skips errors missing a usable position", () => {
    const out = parsePyreflyJson(
      JSON.stringify({
        errors: [
          { name: "a", description: "no pos" },
          { line: 0, column: 1, description: "bad line" },
          { line: 7, column: 3, description: "ok" },
        ],
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ line: 7, column: 3, message: "ok" })
  })

  test("omits range when stop positions are absent", () => {
    const [d] = parsePyreflyJson(
      JSON.stringify({ errors: [{ line: 1, column: 1, description: "x" }] }),
    )
    expect(d).not.toHaveProperty("endLine")
    expect(d).not.toHaveProperty("endColumn")
  })
})

describe("parsePyreflyJson — property: total + well-formed", () => {
  test("never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => parsePyreflyJson(s)).not.toThrow()
      }),
    )
  })

  test("never throws on arbitrary JSON, output well-formed", () => {
    fc.assert(
      fc.property(fc.json(), (jsonText) => {
        const out = parsePyreflyJson(jsonText)
        expect(Array.isArray(out)).toBe(true)
        for (const d of out) assertWellFormed(d)
      }),
    )
  })

  test("survives arbitrary error entries", () => {
    const err = fc.record(
      {
        line: fc.oneof(fc.integer(), fc.constant(null)),
        column: fc.oneof(fc.integer(), fc.constant(null)),
        stop_line: fc.oneof(fc.integer(), fc.constant(undefined)),
        stop_column: fc.oneof(fc.integer(), fc.constant(undefined)),
        name: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
        description: fc.oneof(fc.string(), fc.constant(undefined)),
        severity: fc.oneof(fc.string(), fc.constant(undefined)),
      },
      { requiredKeys: [] },
    )
    fc.assert(
      fc.property(fc.array(fc.oneof(err, fc.anything())), (errors) => {
        const out = parsePyreflyJson(JSON.stringify({ errors }))
        for (const d of out) assertWellFormed(d)
      }),
    )
  })
})
