// Integration tests for the workspaces router: createCaller over
// a temp SQLite DB with real migrations, real temp git repos, an in-process
// pty-daemon for launchAgent, and an injected fake agent. Full cleanup per test.
import { existsSync } from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentSessions } from "@pi-lab/local-db"
import type { TerminalAgent } from "@pi-lab/shared"
import type { Unsubscribable } from "@trpc/server/observable"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { TerminalEvent } from "../terminal/terminal"
import { createHarness, FAKE_AGENT, type Harness } from "../testHarness"

let h: Harness
let projectId: string
const subscriptions: Unsubscribable[] = []

const WORKSPACE_PROMPT_AGENT: TerminalAgent = {
  id: "workspace-prompt-agent",
  label: "Workspace Prompt Agent",
  command: process.execPath,
  detect: "node",
  defaultArgs: [
    "-e",
    "process.stdin.setEncoding('utf8');process.stdout.write('OpenAI Codex\\n\\n› Ask Codex to do anything\\n  gpt-5 · 97% left\\n');process.stdin.once('data',()=>process.stdout.write('\\nFinished from workspace launch.\\n\\n› Ask Codex to do anything\\n  gpt-5 · 96% left\\n'));process.stdin.resume()",
  ],
}

beforeEach(async () => {
  h = await createHarness([FAKE_AGENT, WORKSPACE_PROMPT_AGENT], {
    notificationsUnfocused: true,
    nativeNotificationsSupported: true,
  })
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

  test("rejects worktrees for a non-Git project with an Initialize Git explanation", async () => {
    const plain = await mkdtemp(join(tmpdir(), "pi-lab-plain-workspace-"))
    const project = await h.caller.projects.open({ path: plain })

    await expect(
      h.caller.workspaces.create({
        projectId: project.id,
        kind: "worktree",
        name: "Unavailable",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("Initialize Git"),
    })
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

  test("explains that Code changes requires Git", async () => {
    const plain = await mkdtemp(join(tmpdir(), "pi-lab-plain-changes-"))
    const project = await h.caller.projects.open({ path: plain })
    const workspace = await h.caller.workspaces.ensureMain({ projectId: project.id })

    await expect(h.caller.workspaces.changes({ id: workspace.id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("Initialize Git"),
    })
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

  test("simultaneous launches cannot multiplex agents in a non-Git folder", async () => {
    const plain = await mkdtemp(join(tmpdir(), "pi-lab-plain-workspace-race-"))
    const project = await h.caller.projects.open({ path: plain })
    const workspace = await h.caller.workspaces.ensureMain({ projectId: project.id })

    const results = await Promise.allSettled([
      h.caller.workspaces.launchAgent({
        workspaceId: workspace.id,
        agentId: WORKSPACE_PROMPT_AGENT.id,
      }),
      h.caller.workspaces.launchAgent({
        workspaceId: workspace.id,
        agentId: WORKSPACE_PROMPT_AGENT.id,
      }),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: {
        code: "PRECONDITION_FAILED",
        message: expect.stringContaining("one agent"),
      },
    })

    const started = results.find((result) => result.status === "fulfilled")
    if (started?.status === "fulfilled") {
      await h.caller.terminal.kill({ sessionId: started.value.sessionId })
    }
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

  test("the workspace launch entry independently notifies only after a submitted agent turn", async () => {
    const main = await h.caller.workspaces.ensureMain({ projectId })
    const { sessionId } = await h.caller.workspaces.launchAgent({
      workspaceId: main.id,
      agentId: WORKSPACE_PROMPT_AGENT.id,
    })

    // Deliberately do not subscribe to terminal.onData. The app-lifetime monitor
    // must be registered by this public launch entry itself. Its initial blank
    // prompt is not a completed turn.
    await waitFor(() => {
      const durable = h.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.sessionId, sessionId))
        .get()
      return durable?.state === "waiting" && durable.waitingReason === "initial-prompt"
    })
    expect(h.notificationDeliveries).toEqual([])

    await h.caller.terminal.write({
      sessionId,
      data: "Implement the workspace change\r",
    })
    await waitFor(() =>
      h.notificationDeliveries.some(
        ({ input }) =>
          input.title === "Agent finished its turn" &&
          input.body.includes(WORKSPACE_PROMPT_AGENT.id),
      ),
    )
    expect(h.notificationDeliveries).toContainEqual(
      expect.objectContaining({
        input: expect.objectContaining({ title: "Agent finished its turn", silent: true }),
      }),
    )

    await h.caller.terminal.kill({ sessionId })
  })
})

describe("workspaces.ensureMain", () => {
  test("is idempotent: a second call returns the same branch workspace", async () => {
    const first = await h.caller.workspaces.ensureMain({ projectId })
    expect(first.kind).toBe("branch")
    expect(first.projectId).toBe(projectId)

    const second = await h.caller.workspaces.ensureMain({ projectId })
    expect(second.id).toBe(first.id)

    // Exactly one branch workspace exists for the project.
    const all = await h.caller.workspaces.list({ projectId })
    expect(all.filter((w) => w.kind === "branch")).toHaveLength(1)
  })
})

describe("workspaces.spawnTerminal", () => {
  test("returns a session id and spawns a shell in the workspace's working dir", async () => {
    const main = await h.caller.workspaces.ensureMain({ projectId })

    const { sessionId } = await h.caller.workspaces.spawnTerminal({
      workspaceId: main.id,
      cols: 80,
      rows: 24,
    })
    expect(sessionId).toBeTruthy()

    // The daemon records the spawn cwd; assert it is the branch workspace's
    // working dir (the project repo root).
    const sessions = await h.caller.terminal.list()
    const spawned = sessions.find((s) => s.id === sessionId)
    expect(spawned?.cwd).toBe(h.repoDir)

    await h.caller.terminal.kill({ sessionId })
  })

  test("uses the worktree path for a worktree workspace", async () => {
    const { workspace, worktree } = await h.caller.workspaces.create({
      projectId,
      kind: "worktree",
      name: "Term",
      branch: "feature/term",
    })

    const { sessionId } = await h.caller.workspaces.spawnTerminal({
      workspaceId: workspace.id,
      cols: 80,
      rows: 24,
    })

    const sessions = await h.caller.terminal.list()
    const spawned = sessions.find((s) => s.id === sessionId)
    expect(spawned?.cwd).toBe(worktree?.path)

    await h.caller.terminal.kill({ sessionId })
  })

  test("an unknown workspace id is NOT_FOUND", async () => {
    await expect(
      h.caller.workspaces.spawnTerminal({ workspaceId: "ghost", cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  test("notifies through the independent monitor when a submitted command returns to the prompt", async () => {
    const main = await h.caller.workspaces.ensureMain({ projectId })
    const { sessionId } = await h.caller.workspaces.spawnTerminal({
      workspaceId: main.id,
      cols: 80,
      rows: 24,
    })

    // Exercise the public write mutation without a renderer onData subscription:
    // closing/detaching the tab cannot be required for lifecycle observation.
    await h.caller.terminal.write({
      sessionId,
      data: "printf 'TERMINAL-COMPLETION-OK\\\\n'\r",
    })
    await waitFor(() =>
      h.notificationDeliveries.some(
        ({ input }) => input.title === "Terminal command finished" && input.body.includes("ready"),
      ),
    )

    const delivery = h.notificationDeliveries.find(
      ({ input }) => input.title === "Terminal command finished",
    )
    expect(delivery?.input).toMatchObject({
      title: "Terminal command finished",
      silent: true,
    })

    const activations: unknown[] = []
    const unsubscribe = h.notifications.activations.subscribe((target) => activations.push(target))
    delivery?.handlers.onClick()
    expect(activations).toEqual([
      {
        type: "terminal",
        projectId,
        workspaceId: main.id,
        sessionId,
        label: "Terminal",
      },
    ])
    unsubscribe()
    await h.caller.terminal.kill({ sessionId })
  })
})
