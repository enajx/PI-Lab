// Unit tests for the one-shot diagnostics runners (docs/testing-and-build.md). The runners'
// only I/O is the injected exec, so we drive them with a deterministic fake
// returning canned ruff-JSON / ty / pyrefly output — and a "binary missing"
// branch — and assert the parse + graceful-absence contract with no `uv`.
import { describe, expect, test } from "vitest"
import type { PyToolExecResult, PyToolsExec } from "./pyToolsExec"
import { runFormat, runLint, runTypeCheck } from "./runners"

/** Build a fake exec that records its calls and returns per-tool canned results. */
function fakeExec(byTool: Partial<Record<"ty" | "pyrefly" | "ruff", PyToolExecResult>>): {
  exec: PyToolsExec
  calls: { tool: string; args: readonly string[]; cwd: string }[]
} {
  const calls: { tool: string; args: readonly string[]; cwd: string }[] = []
  const exec: PyToolsExec = async ({ tool, args, cwd }) => {
    calls.push({ tool, args, cwd })
    return byTool[tool] ?? { stdout: "", stderr: "", code: null, notFound: true }
  }
  return { exec, calls }
}

const NOT_FOUND: PyToolExecResult = { stdout: "", stderr: "", code: null, notFound: true }

const TY_OUT =
  "app.py:2:5: error[unresolved-reference] Name `x` used when not defined\nFound 1 diagnostic"
const PYREFLY_OUT = JSON.stringify({
  errors: [
    {
      line: 2,
      column: 5,
      name: "unknown-name",
      description: "Could not find name `x`",
      severity: "error",
    },
  ],
})
const RUFF_OUT = JSON.stringify([
  {
    code: "F821",
    location: { row: 2, column: 5 },
    end_location: { row: 2, column: 6 },
    message: "Undefined name `x`",
    severity: "error",
  },
])

describe("runTypeCheck", () => {
  test("ty: invokes the concise format and parses diagnostics", async () => {
    const { exec, calls } = fakeExec({
      ty: { stdout: TY_OUT, stderr: "", code: 1, notFound: false },
    })
    const result = await runTypeCheck(exec, "ty", "app.py", "/work")
    expect(result.available).toBe(true)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({ source: "ty", line: 2, column: 5 })
    expect(calls[0]).toMatchObject({
      tool: "ty",
      args: ["check", "--output-format", "concise", "--color", "never", "app.py"],
      cwd: "/work",
    })
  })

  test("pyrefly: invokes the json format and parses diagnostics", async () => {
    const { exec, calls } = fakeExec({
      pyrefly: { stdout: PYREFLY_OUT, stderr: "", code: 1, notFound: false },
    })
    const result = await runTypeCheck(exec, "pyrefly", "app.py", "/work")
    expect(result.available).toBe(true)
    expect(result.diagnostics[0]).toMatchObject({ source: "pyrefly", line: 2, column: 5 })
    expect(calls[0]).toMatchObject({
      tool: "pyrefly",
      args: ["check", "--output-format", "json", "app.py"],
    })
  })

  test("absent type checker → available:false, no diagnostics (never throws)", async () => {
    const { exec } = fakeExec({ ty: NOT_FOUND })
    const result = await runTypeCheck(exec, "ty", "app.py", "/work")
    expect(result).toEqual({ available: false, diagnostics: [] })
  })
})

describe("runLint", () => {
  test("parses ruff JSON into diagnostics", async () => {
    const { exec, calls } = fakeExec({
      ruff: { stdout: RUFF_OUT, stderr: "", code: 1, notFound: false },
    })
    const result = await runLint(exec, "app.py", "/work")
    expect(result.available).toBe(true)
    expect(result.diagnostics[0]).toMatchObject({ source: "ruff", code: "F821", line: 2 })
    expect(calls[0]).toMatchObject({
      tool: "ruff",
      args: ["check", "app.py", "--output-format", "json"],
    })
  })

  test("absent ruff → available:false (never throws)", async () => {
    const { exec } = fakeExec({ ruff: NOT_FOUND })
    expect(await runLint(exec, "app.py", "/work")).toEqual({ available: false, diagnostics: [] })
  })

  test("a clean file (ruff '[]') yields no diagnostics but available:true", async () => {
    const { exec } = fakeExec({ ruff: { stdout: "[]", stderr: "", code: 0, notFound: false } })
    expect(await runLint(exec, "app.py", "/work")).toEqual({ available: true, diagnostics: [] })
  })
})

describe("runFormat", () => {
  test("reports changed when ruff reformats the file", async () => {
    const { exec, calls } = fakeExec({
      ruff: { stdout: "1 file reformatted\n", stderr: "", code: 0, notFound: false },
    })
    expect(await runFormat(exec, "app.py", "/work")).toEqual({ available: true, changed: true })
    expect(calls[0]).toMatchObject({ tool: "ruff", args: ["format", "app.py"] })
  })

  test("reports unchanged when the file is already formatted", async () => {
    const { exec } = fakeExec({
      ruff: { stdout: "1 file left unchanged\n", stderr: "", code: 0, notFound: false },
    })
    expect(await runFormat(exec, "app.py", "/work")).toEqual({ available: true, changed: false })
  })

  test("absent ruff → available:false, changed:false (never throws)", async () => {
    const { exec } = fakeExec({ ruff: NOT_FOUND })
    expect(await runFormat(exec, "app.py", "/work")).toEqual({ available: false, changed: false })
  })
})
