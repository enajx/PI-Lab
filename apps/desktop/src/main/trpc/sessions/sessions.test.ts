// Integration tests for the start-agent-session policy (AGENTS.md §8, P5b):
// createCaller over a temp SQLite DB with real migrations, real temp git repos,
// an in-process pty-daemon, and injected fake agents (one short-lived, one
// long-lived so a session can be held open across a second start). Full cleanup
// per test; concurrency assertions poll with timeouts, never fixed sleeps.
import { existsSync } from "node:fs"
import { settings } from "@skipper/local-db"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createHarness, FAKE_AGENT, type Harness, LONG_FAKE_AGENT, makeRepo } from "../testHarness"
import { workspaceWorkingDir } from "../workspaces"

let h: Harness
let projectId: string

beforeEach(async () => {
  h = await createHarness([FAKE_AGENT, LONG_FAKE_AGENT])
  const project = await h.caller.projects.open({ path: h.repoDir })
  projectId = project.id
})

afterEach(async () => {
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

/** Persist the singleton settings row with worktreePerAgent flipped on. */
function enableWorktreePerAgent(): void {
  h.db.insert(settings).values({ id: 1, worktreePerAgent: true }).run()
}

describe("sessions.start — default policy (worktreePerAgent OFF)", () => {
  test("no prior agent -> kind 'branch', cwd is the repo root, agent runs", async () => {
    const result = await h.caller.sessions.start({ projectId, agentId: "fake-agent" })

    expect(result.kind).toBe("branch")
    expect(result.sessionId).toBeTruthy()
    expect(result.workspaceId).toBeTruthy()

    // The session's workspace is branch-kind and rooted at the project repo root.
    const workspace = await h.caller.workspaces.get({ id: result.workspaceId })
    expect(workspace.kind).toBe("branch")
    expect(workspaceWorkingDir(h.db, workspace)).toBe(h.repoDir)

    // The agent really ran in that cwd (marker reaches the data stream).
    const chunks: string[] = []
    const stream = await h.caller.terminal.onData({ sessionId: result.sessionId })
    const sub = stream.subscribe({
      next: (event) => {
        if (event.type === "data") chunks.push(event.chunk)
      },
    })
    await waitFor(() => chunks.join("").includes("AGENT-OK"))
    sub.unsubscribe()
    expect(chunks.join("")).toContain("AGENT-OK")
  })

  test("a long-lived agent makes the 2nd start (same project) a 'worktree'; another project stays 'branch'", async () => {
    // First start: branch (main checkout), held live by the long agent.
    const first = await h.caller.sessions.start({ projectId, agentId: "long-fake-agent" })
    expect(first.kind).toBe("branch")
    await waitFor(() => h.liveAgents.liveAgentCount(projectId) === 1)

    // A second concurrent start for the SAME project must get its own worktree.
    const second = await h.caller.sessions.start({ projectId, agentId: "fake-agent" })
    expect(second.kind).toBe("worktree")
    expect(second.workspaceId).not.toBe(first.workspaceId)

    const secondWs = await h.caller.workspaces.get({ id: second.workspaceId })
    expect(secondWs.kind).toBe("worktree")
    const wtDir = workspaceWorkingDir(h.db, secondWs)
    expect(wtDir).not.toBe(h.repoDir)
    expect(existsSync(wtDir)).toBe(true)

    // Meanwhile a DIFFERENT project (no live agent) still opens in its branch.
    const repo2 = await makeRepo(h.dataDir)
    const project2 = await h.caller.projects.open({ path: repo2 })
    const other = await h.caller.sessions.start({
      projectId: project2.id,
      agentId: "fake-agent",
    })
    expect(other.kind).toBe("branch")
    const otherWs = await h.caller.workspaces.get({ id: other.workspaceId })
    expect(workspaceWorkingDir(h.db, otherWs)).toBe(repo2)

    // Release the held session.
    await h.caller.terminal.kill({ sessionId: first.sessionId })
  })
})

describe("sessions.start — worktreePerAgent ON", () => {
  test("the FIRST start is already a 'worktree'", async () => {
    enableWorktreePerAgent()

    const result = await h.caller.sessions.start({ projectId, agentId: "fake-agent" })
    expect(result.kind).toBe("worktree")

    const workspace = await h.caller.workspaces.get({ id: result.workspaceId })
    expect(workspace.kind).toBe("worktree")
    expect(existsSync(workspaceWorkingDir(h.db, workspace))).toBe(true)
  })
})

describe("sessions.start — registry drains on exit", () => {
  test("after a session exits the next start is 'branch' again, reusing the one branch workspace", async () => {
    // Hold a live agent so a 2nd start would be a worktree.
    const live = await h.caller.sessions.start({ projectId, agentId: "long-fake-agent" })
    expect(live.kind).toBe("branch")
    await waitFor(() => h.liveAgents.liveAgentCount(projectId) === 1)

    const second = await h.caller.sessions.start({ projectId, agentId: "fake-agent" })
    expect(second.kind).toBe("worktree")

    // Kill the long-lived session; the registry drains via the daemon exit event.
    await h.caller.terminal.kill({ sessionId: live.sessionId })
    await waitFor(() => h.liveAgents.liveAgentCount(projectId) === 0)

    // The next start is branch again — and reuses the existing single branch
    // workspace (no CONFLICT, same workspace id as the first branch start).
    const third = await h.caller.sessions.start({ projectId, agentId: "fake-agent" })
    expect(third.kind).toBe("branch")
    expect(third.workspaceId).toBe(live.workspaceId)

    // Exactly one branch workspace exists for the project.
    const all = await h.caller.workspaces.list({ projectId })
    const branchCount = all.filter((w) => w.kind === "branch").length
    expect(branchCount).toBe(1)
  })
})
