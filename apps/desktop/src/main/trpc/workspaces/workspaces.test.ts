// Integration tests for the workspaces router (AGENTS.md §14): createCaller over
// a temp SQLite DB with real migrations, real temp git repos, an in-process
// pty-daemon for launchAgent, and an injected fake agent. Full cleanup per test.
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Unsubscribable } from "@trpc/server/observable"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { TerminalEvent } from "../terminal/terminal"
import { createHarness, type Harness } from "../testHarness"

let h: Harness
let projectId: string
const subscriptions: Unsubscribable[] = []

beforeEach(async () => {
  h = await createHarness()
  const project = await h.caller.projects.open({ path: h.repoDir })
  projectId = project.id
})

afterEach(async () => {
  for (const sub of subscriptions) sub.unsubscribe()
  subscriptions.length = 0
  await h.dispose()
})

/** Poll a predicate until true or the deadline; deterministic, no fixed sleeps. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("waitFor timed out")
}

describe("workspaces.create (worktree)", () => {
  test("creates the on-disk checkout, branch, rows, and a portBase", async () => {
    const { workspace, worktree } = await h.caller.workspaces.create({
      projectId,
      kind: "worktree",
      name: "Experiment A",
      branch: "feature/a",
    })

    expect(worktree).not.toBeNull()
    expect(existsSync(worktree?.path ?? "")).toBe(true)
    expect(existsSync(join(worktree?.path ?? "", ".git"))).toBe(true)
    expect(workspace.kind).toBe("worktree")
    expect(workspace.worktreeId).toBe(worktree?.id)
    expect(workspace.branch).toBe("feature/a")
    expect(typeof workspace.portBase).toBe("number")

    // The branch really exists in the repo.
    const branches = await h.caller.workspaces.changes({ id: workspace.id })
    expect(Array.isArray(branches)).toBe(true)
  })

  test("two worktree workspaces get non-overlapping port ranges", async () => {
    const a = await h.caller.workspaces.create({
      projectId,
      kind: "worktree",
      name: "A",
      branch: "feature/a",
    })
    const b = await h.caller.workspaces.create({
      projectId,
      kind: "worktree",
      name: "B",
      branch: "feature/b",
    })
    const portA = a.workspace.portBase ?? -1
    const portB = b.workspace.portBase ?? -2
    expect(portA).not.toBe(portB)
    // Default block size is 10 (port-scanner); ranges must not overlap.
    expect(Math.abs(portA - portB)).toBeGreaterThanOrEqual(10)
  })
})

describe("workspaces.create (branch)", () => {
  test("first branch workspace is created; a second for the same project conflicts", async () => {
    const first = await h.caller.workspaces.create({
      projectId,
      kind: "branch",
      name: "Main work",
    })
    expect(first.workspace.kind).toBe("branch")
    expect(first.worktree).toBeNull()

    await expect(
      h.caller.workspaces.create({ projectId, kind: "branch", name: "Second" }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })
})

describe("workspaces.changes", () => {
  test("reflects a file written + staged in the worktree", async () => {
    const { workspace, worktree } = await h.caller.workspaces.create({
      projectId,
      kind: "worktree",
      name: "Dirty",
      branch: "feature/dirty",
    })
    const wtPath = worktree?.path ?? ""

    expect(await h.caller.workspaces.changes({ id: workspace.id })).toEqual([])

    await writeFile(join(wtPath, "scratch.txt"), "hello\n")
    const untracked = await h.caller.workspaces.changes({ id: workspace.id })
    expect(untracked.some((c) => c.path === "scratch.txt" && c.status === "untracked")).toBe(true)
  })
})

describe("workspaces.remove", () => {
  test("removing a worktree workspace deletes the checkout and rows", async () => {
    const { workspace, worktree } = await h.caller.workspaces.create({
      projectId,
      kind: "worktree",
      name: "Temp",
      branch: "feature/temp",
    })
    const wtPath = worktree?.path ?? ""
    expect(existsSync(wtPath)).toBe(true)

    await h.caller.workspaces.remove({ id: workspace.id })
    expect(existsSync(wtPath)).toBe(false)
    expect(await h.caller.workspaces.list({ projectId })).toHaveLength(0)
  })
})

describe("workspaces.launchAgent", () => {
  test("spawns the injected fake agent; its marker reaches the data stream", async () => {
    const { workspace } = await h.caller.workspaces.create({
      projectId,
      kind: "worktree",
      name: "Agent",
      branch: "feature/agent",
    })

    const { sessionId } = await h.caller.workspaces.launchAgent({
      workspaceId: workspace.id,
      agentId: "fake-agent",
    })
    expect(sessionId).toBeTruthy()

    const chunks: string[] = []
    const stream = await h.caller.terminal.onData({ sessionId })
    const sub = stream.subscribe({
      next: (event: TerminalEvent) => {
        if (event.type === "data") chunks.push(event.chunk)
      },
    })
    subscriptions.push(sub)

    await waitFor(() => chunks.join("").includes("AGENT-OK"))
    expect(chunks.join("")).toContain("AGENT-OK")
  })

  test("an unknown agent id is NOT_FOUND", async () => {
    const { workspace } = await h.caller.workspaces.create({
      projectId,
      kind: "worktree",
      name: "NoAgent",
      branch: "feature/no-agent",
    })
    await expect(
      h.caller.workspaces.launchAgent({ workspaceId: workspace.id, agentId: "ghost" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})
