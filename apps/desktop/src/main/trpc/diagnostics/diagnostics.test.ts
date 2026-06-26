// Integration tests for the diagnostics router (docs/testing-and-build.md): createCaller over
// a temp SQLite DB with real migrations + a real temp git repo, with the Python
// tools exec injected as a deterministic fake returning canned ruff-JSON / ty /
// pyrefly output (plus a "binary missing" branch). No `uv` is required. They
// prove diagnostics map + merge correctly, the tools-absent path reports
// toolsAvailable:false, the type-checker toggle, format-on-save, and that the
// files traversal guard is reused.
import { afterEach, describe, expect, test } from "vitest"
import type { PyToolExecResult, PyToolsExec } from "../../diagnostics"
import { createHarness, type Harness } from "../testHarness"

// Canned tool outputs (same shapes the live CLIs emit).
const TY_OUT =
  "app.py:3:14: error[invalid-assignment] Object of type `Literal[123]` is not assignable to `str`\nFound 1 diagnostic"
const PYREFLY_OUT = JSON.stringify({
  errors: [
    {
      line: 4,
      column: 16,
      stop_line: 4,
      stop_column: 30,
      name: "unknown-name",
      description: "Could not find name `undefined_name`",
      severity: "error",
    },
  ],
})
const RUFF_OUT = JSON.stringify([
  {
    code: "F401",
    location: { row: 1, column: 8 },
    end_location: { row: 1, column: 10 },
    message: "`os` imported but unused",
    severity: "error",
  },
])

const NOT_FOUND: PyToolExecResult = { stdout: "", stderr: "", code: null, notFound: true }

/** A fake exec that records calls and returns canned per-tool results. */
function cannedExec(byTool: Partial<Record<"ty" | "pyrefly" | "ruff", PyToolExecResult>>): {
  exec: PyToolsExec
  calls: { tool: string; args: readonly string[]; cwd: string }[]
} {
  const calls: { tool: string; args: readonly string[]; cwd: string }[] = []
  const exec: PyToolsExec = async ({ tool, args, cwd }) => {
    calls.push({ tool, args, cwd })
    return byTool[tool] ?? NOT_FOUND
  }
  return { exec, calls }
}

let h: Harness
let projectId: string

async function setup(exec: PyToolsExec): Promise<void> {
  h = await createHarness(undefined, { pyToolsExec: exec })
  const project = await h.caller.projects.open({ path: h.repoDir })
  projectId = project.id
}

afterEach(async () => {
  await h.dispose()
})

/** Create a worktree workspace and return its id + on-disk working dir. */
async function makeWorkspace(): Promise<{ id: string; dir: string }> {
  const { workspace, worktree } = await h.caller.workspaces.create({
    projectId,
    kind: "worktree",
    name: "Editor",
    branch: "feature/editor",
  })
  return { id: workspace.id, dir: worktree?.path ?? "" }
}

describe("diagnostics.check — mapping + merge", () => {
  test("ty + ruff: diagnostics from both tools merge, toolsAvailable:true", async () => {
    const { exec, calls } = cannedExec({
      ty: { stdout: TY_OUT, stderr: "", code: 1, notFound: false },
      ruff: { stdout: RUFF_OUT, stderr: "", code: 1, notFound: false },
    })
    await setup(exec)
    const ws = await makeWorkspace()

    const result = await h.caller.diagnostics.check({
      workspaceId: ws.id,
      relPath: "app.py",
      typeChecker: "ty",
      lint: true,
    })

    expect(result.toolsAvailable).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.diagnostics).toHaveLength(2)
    const sources = result.diagnostics.map((d) => d.source).sort()
    expect(sources).toEqual(["ruff", "ty"])
    // The tools run with the workspace working dir as cwd and a relative path arg.
    expect(calls.every((c) => c.cwd === ws.dir)).toBe(true)
    expect(calls.find((c) => c.tool === "ty")?.args).toContain("app.py")
  })

  test("lint:false runs only the type checker", async () => {
    const { exec, calls } = cannedExec({
      ty: { stdout: TY_OUT, stderr: "", code: 1, notFound: false },
      ruff: { stdout: RUFF_OUT, stderr: "", code: 1, notFound: false },
    })
    await setup(exec)
    const ws = await makeWorkspace()

    const result = await h.caller.diagnostics.check({
      workspaceId: ws.id,
      relPath: "app.py",
      typeChecker: "ty",
      lint: false,
    })

    expect(calls.map((c) => c.tool)).toEqual(["ty"])
    expect(result.diagnostics.every((d) => d.source === "ty")).toBe(true)
  })

  test("typeChecker:'pyrefly' routes to pyrefly", async () => {
    const { exec, calls } = cannedExec({
      pyrefly: { stdout: PYREFLY_OUT, stderr: "", code: 1, notFound: false },
    })
    await setup(exec)
    const ws = await makeWorkspace()

    const result = await h.caller.diagnostics.check({
      workspaceId: ws.id,
      relPath: "app.py",
      typeChecker: "pyrefly",
      lint: false,
    })

    expect(calls[0]?.tool).toBe("pyrefly")
    expect(result.diagnostics[0]).toMatchObject({ source: "pyrefly", line: 4, column: 16 })
  })

  test("a clean file yields no diagnostics but toolsAvailable:true", async () => {
    const { exec } = cannedExec({
      ty: { stdout: "All checks passed!\n", stderr: "", code: 0, notFound: false },
      ruff: { stdout: "[]", stderr: "", code: 0, notFound: false },
    })
    await setup(exec)
    const ws = await makeWorkspace()
    const result = await h.caller.diagnostics.check({
      workspaceId: ws.id,
      relPath: "app.py",
      typeChecker: "ty",
      lint: true,
    })
    expect(result).toEqual({ diagnostics: [], toolsAvailable: true, missing: [] })
  })
})

describe("diagnostics.check — graceful when tools absent", () => {
  test("everything missing → toolsAvailable:false, names both missing tools", async () => {
    const { exec } = cannedExec({}) // every tool resolves to notFound
    await setup(exec)
    const ws = await makeWorkspace()

    const result = await h.caller.diagnostics.check({
      workspaceId: ws.id,
      relPath: "app.py",
      typeChecker: "ty",
      lint: true,
    })

    expect(result.diagnostics).toEqual([])
    expect(result.toolsAvailable).toBe(false)
    expect(result.missing.sort()).toEqual(["ruff", "ty"])
  })

  test("only ruff missing → ty diagnostics still returned, missing:['ruff']", async () => {
    const { exec } = cannedExec({
      ty: { stdout: TY_OUT, stderr: "", code: 1, notFound: false },
      ruff: NOT_FOUND,
    })
    await setup(exec)
    const ws = await makeWorkspace()

    const result = await h.caller.diagnostics.check({
      workspaceId: ws.id,
      relPath: "app.py",
      typeChecker: "ty",
      lint: true,
    })

    expect(result.toolsAvailable).toBe(false)
    expect(result.missing).toEqual(["ruff"])
    expect(result.diagnostics.every((d) => d.source === "ty")).toBe(true)
  })
})

describe("diagnostics.format", () => {
  test("reports changed when ruff reformats", async () => {
    const { exec, calls } = cannedExec({
      ruff: { stdout: "1 file reformatted\n", stderr: "", code: 0, notFound: false },
    })
    await setup(exec)
    const ws = await makeWorkspace()
    const result = await h.caller.diagnostics.format({ workspaceId: ws.id, relPath: "app.py" })
    expect(result).toEqual({ toolsAvailable: true, changed: true, missing: [] })
    expect(calls[0]).toMatchObject({ tool: "ruff", args: ["format", "app.py"] })
  })

  test("graceful when ruff/uv absent", async () => {
    const { exec } = cannedExec({ ruff: NOT_FOUND })
    await setup(exec)
    const ws = await makeWorkspace()
    const result = await h.caller.diagnostics.format({ workspaceId: ws.id, relPath: "app.py" })
    expect(result).toEqual({ toolsAvailable: false, changed: false, missing: ["ruff"] })
  })
})

describe("diagnostics — guards", () => {
  test("a path escaping the working dir is FORBIDDEN (before any exec)", async () => {
    const { exec, calls } = cannedExec({
      ty: { stdout: TY_OUT, stderr: "", code: 1, notFound: false },
    })
    await setup(exec)
    const ws = await makeWorkspace()
    await expect(
      h.caller.diagnostics.check({
        workspaceId: ws.id,
        relPath: "../escape.py",
        typeChecker: "ty",
        lint: false,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(calls).toHaveLength(0)
  })

  test("an unknown workspace id is NOT_FOUND", async () => {
    const { exec } = cannedExec({})
    await setup(exec)
    await expect(
      h.caller.diagnostics.check({
        workspaceId: "ghost",
        relPath: "app.py",
        typeChecker: "ty",
        lint: false,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})
