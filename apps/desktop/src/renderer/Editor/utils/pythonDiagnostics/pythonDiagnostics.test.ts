import { describe, expect, it } from "vitest"
import {
  countDiagnostics,
  isPythonPath,
  lineColToOffset,
  type SkipperDiagnostic,
  toCmDiagnostics,
} from "./pythonDiagnostics"

describe("isPythonPath", () => {
  it("matches .py and .pyi case-insensitively", () => {
    expect(isPythonPath("main.py")).toBe(true)
    expect(isPythonPath("pkg/mod.PY")).toBe(true)
    expect(isPythonPath("stubs/foo.pyi")).toBe(true)
  })

  it("rejects non-Python files", () => {
    expect(isPythonPath("readme.md")).toBe(false)
    expect(isPythonPath("script.pyc")).toBe(false)
    expect(isPythonPath("Pipfile")).toBe(false)
  })
})

describe("lineColToOffset", () => {
  const doc = "ab\ncde\nf"

  it("converts 1-based line/column to a 0-based offset", () => {
    expect(lineColToOffset(doc, 1, 1)).toBe(0)
    expect(lineColToOffset(doc, 1, 3)).toBe(2)
    // Line 2 starts after "ab\n" = offset 3.
    expect(lineColToOffset(doc, 2, 1)).toBe(3)
    expect(lineColToOffset(doc, 3, 1)).toBe(7)
  })

  it("clamps out-of-range positions into the document", () => {
    expect(lineColToOffset(doc, 99, 99)).toBe(8) // last line, end of doc
    expect(lineColToOffset(doc, 1, 0)).toBe(0)
  })
})

describe("toCmDiagnostics", () => {
  const doc = "import os\nx = 1\n"

  it("maps a ranged diagnostic to character offsets and folds the code into source", () => {
    const diags: SkipperDiagnostic[] = [
      {
        source: "ruff",
        severity: "warning",
        line: 1,
        column: 8,
        endLine: 1,
        endColumn: 10,
        message: "`os` imported but unused",
        code: "F401",
      },
    ]
    const [cm] = toCmDiagnostics(doc, diags)
    if (!cm) throw new Error("expected a diagnostic")
    expect(cm.from).toBe(7)
    expect(cm.to).toBe(9)
    expect(cm.severity).toBe("warning")
    expect(cm.source).toBe("ruff (F401)")
    expect(cm.message).toBe("`os` imported but unused")
  })

  it("gives a point diagnostic a one-char span so the squiggle is visible", () => {
    const diags: SkipperDiagnostic[] = [
      { source: "ty", severity: "error", line: 2, column: 1, message: "bad" },
    ]
    const [cm] = toCmDiagnostics(doc, diags)
    if (!cm) throw new Error("expected a diagnostic")
    expect(cm.from).toBe(10)
    expect(cm.to).toBe(11)
    expect(cm.source).toBe("ty")
  })
})

describe("countDiagnostics", () => {
  it("tallies by severity", () => {
    const diags: SkipperDiagnostic[] = [
      { source: "ty", severity: "error", line: 1, column: 1, message: "a" },
      { source: "ruff", severity: "warning", line: 2, column: 1, message: "b" },
      { source: "ruff", severity: "warning", line: 3, column: 1, message: "c" },
      { source: "ty", severity: "info", line: 4, column: 1, message: "d" },
    ]
    expect(countDiagnostics(diags)).toEqual({ errors: 1, warnings: 2, infos: 1 })
  })
})
