// Unit + property tests for the ty concise-format parser (docs/testing-and-build.md). Pure
// line-based transform, so example tests against the real `ty check
// --output-format concise` shape plus fast-check totality properties.
import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { assertWellFormed } from "./parseRuff.test"
import { parseConciseLines, parseTyConcise } from "./parseTy"
import type { Diagnostic } from "./types"

// Real `ty check --output-format concise --color never` output, including the
// trailing summary line which carries no position and must be ignored.
const TY_FIXTURE = [
  "diag_probe.py:3:14: error[invalid-assignment] Object of type `Literal[123]` is not assignable to `str`",
  "diag_probe.py:4:16: error[unresolved-reference] Name `undefined_name` used when not defined",
  "Found 2 diagnostics",
].join("\n")

describe("parseTyConcise — real-shaped output", () => {
  test("maps each diagnostic line; ignores the summary line", () => {
    expect(parseTyConcise(TY_FIXTURE)).toEqual<Diagnostic[]>([
      {
        source: "ty",
        severity: "error",
        line: 3,
        column: 14,
        message: "Object of type `Literal[123]` is not assignable to `str`",
        code: "invalid-assignment",
      },
      {
        source: "ty",
        severity: "error",
        line: 4,
        column: 16,
        message: "Name `undefined_name` used when not defined",
        code: "unresolved-reference",
      },
    ])
  })

  test("the clean / no-diagnostics output parses to []", () => {
    expect(parseTyConcise("All checks passed!\n")).toEqual([])
  })

  test("handles a Windows-style path with a drive-letter colon", () => {
    const out = parseTyConcise("C:\\proj\\app.py:10:2: warning[foo] something")
    expect(out).toEqual<Diagnostic[]>([
      { source: "ty", severity: "warning", line: 10, column: 2, message: "something", code: "foo" },
    ])
  })

  test("parses a line with no [code] bracket", () => {
    const out = parseTyConcise("app.py:1:1: error some bare message")
    expect(out[0]).toMatchObject({ line: 1, column: 1, message: "some bare message" })
    expect(out[0]).not.toHaveProperty("code")
  })

  test("maps info-level severities", () => {
    const out = parseTyConcise("app.py:1:1: info[note] just so you know")
    expect(out[0]?.severity).toBe("info")
  })

  test("CRLF line endings split correctly", () => {
    const out = parseTyConcise("app.py:1:1: error[a] one\r\napp.py:2:1: error[b] two\r\n")
    expect(out.map((d) => d.code)).toEqual(["a", "b"])
  })
})

describe("parseConciseLines — pyrefly min-text reuse", () => {
  test("tags the source as pyrefly when asked", () => {
    const out = parseConciseLines(
      "app.py:4:16: error[unknown-name] Could not find name `x`",
      "pyrefly",
    )
    expect(out[0]).toMatchObject({ source: "pyrefly", code: "unknown-name", line: 4, column: 16 })
  })
})

describe("parseTyConcise — defensive / graceful", () => {
  test.each([
    ["empty string", ""],
    ["only a summary line", "Found 0 diagnostics"],
    ["blank lines", "\n\n   \n"],
    ["garbage", "this is not a diagnostic line"],
    ["partial position", "app.py:abc: error[x] nope"],
  ])("returns [] for %s", (_label, input) => {
    expect(parseTyConcise(input)).toEqual([])
  })

  test("skips a non-matching line but keeps a valid neighbor", () => {
    const out = parseTyConcise("noise line\napp.py:2:3: error[z] real one\nFound 1 diagnostic")
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ line: 2, column: 3, code: "z" })
  })
})

describe("parseTyConcise — property: total + well-formed", () => {
  test("never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => parseTyConcise(s)).not.toThrow()
        for (const d of parseTyConcise(s)) assertWellFormed(d)
      }),
    )
  })

  test("never throws on arbitrary multi-line text", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (lines) => {
        const out = parseTyConcise(lines.join("\n"))
        for (const d of out) assertWellFormed(d)
      }),
    )
  })

  test("synthesized well-formed lines round-trip to diagnostics", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99999 }),
        fc.integer({ min: 1, max: 999 }),
        fc.constantFrom("error", "warning", "info"),
        fc.stringMatching(/^[a-z-]{1,20}$/),
        (line, col, sev, code) => {
          const out = parseTyConcise(`file.py:${line}:${col}: ${sev}[${code}] msg`)
          expect(out).toHaveLength(1)
          expect(out[0]).toMatchObject({ line, column: col, severity: sev, code })
        },
      ),
    )
  })
})
