// Integration tests for the start-agent-session policy (md/engineering/architecture.md (agent runtime), P5b):
// createCaller over a temp SQLite DB with real migrations, real temp git repos,
// an in-process pty-daemon, and injected fake agents (one short-lived, one
// long-lived so a session can be held open across a second start). Full cleanup
// per test; concurrency assertions poll with timeouts, never fixed sleeps.
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentSessions, settings } from "@pi-lab/local-db"
import { DaemonClient } from "@pi-lab/pty-daemon"
import type { TerminalAgent } from "@pi-lab/shared"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  ActivityRegistry,
  createActivityMonitor,
  systemActivityClock,
  systemActivityScheduler,
} from "../../activity"
import { createHarness, FAKE_AGENT, type Harness, LONG_FAKE_AGENT, makeRepo } from "../testHarness"
import { workspaceWorkingDir } from "../workspaces"

let h: Harness
let projectId: string

const PROMPT_AGENT: TerminalAgent = {
  id: "prompt-agent",
  label: "Prompt Agent",
  command: process.execPath,
  detect: "node",
  defaultArgs: ["-e", "process.stdout.write(process.argv[1] ?? 'NO-PROMPT')"],
}

const PERMISSION_AGENT: TerminalAgent = {
  id: "permission-agent",
  label: "Permission Agent",
  command: process.execPath,
  detect: "node",
  defaultArgs: [
    "-e",
    "process.stdout.write('Do you want to allow this command? [y/N]\\n');process.stdin.resume()",
  ],
}

const TURN_COMPLETE_AGENT: TerminalAgent = {
  id: "turn-complete-agent",
  label: "Turn Complete Agent",
  command: process.execPath,
  detect: "node",
  defaultArgs: [
    "-e",
    "process.stdin.setEncoding('utf8');process.stdout.write('OpenAI Codex\\n\\n› Ask Codex to do anything\\n  gpt-5 · 97% left\\n');process.stdin.once('data',()=>process.stdout.write('\\nApplied the requested change.\\n\\n› Ask Codex to do anything\\n  gpt-5 · 96% left\\n'));process.stdin.resume()",
  ],
}

const ENVIRONMENT_AGENT: TerminalAgent = {
  id: "environment-agent",
  label: "Environment Agent",
  command: process.execPath,
  detect: "node",
  defaultArgs: [
    "-e",
    "process.stdout.write('AGENT-ENV:'+(process.env.PI_LAB_ENV_PARITY??'missing'))",
  ],
}

beforeEach(async () => {
  h = await createHarness(
    [
      FAKE_AGENT,
      LONG_FAKE_AGENT,
      PROMPT_AGENT,
      PERMISSION_AGENT,
      TURN_COMPLETE_AGENT,
      ENVIRONMENT_AGENT,
    ],
    {
      notificationsUnfocused: true,
      nativeNotificationsSupported: true,
      getAgentLaunchEnvironment: async () =>
        ({
          ...process.env,
          PI_LAB_ENV_PARITY: "shared-login-environment",
        }) as Record<string, string>,
    },
  )
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
    const durable = h.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.sessionId, result.sessionId))
      .get()
    expect(durable).toMatchObject({
      projectId,
      workspaceId: result.workspaceId,
      agentId: "fake-agent",
    })

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

  test("the public mutation passes an initial prompt to the selected agent", async () => {
    const result = await h.caller.sessions.start({
      projectId,
      agentId: "prompt-agent",
      prompt: "Implement the selected TODO",
    })

    const chunks: string[] = []
    const stream = await h.caller.terminal.onData({ sessionId: result.sessionId })
    const sub = stream.subscribe({
      next: (event) => {
        if (event.type === "data") chunks.push(event.chunk)
      },
    })
    await waitFor(() => chunks.join("").includes("Implement the selected TODO"))
    sub.unsubscribe()
  })

  test("agents and manual project terminals receive the same resolved launch environment", async () => {
    const agent = await h.caller.sessions.start({
      projectId,
      agentId: ENVIRONMENT_AGENT.id,
    })
    const agentChunks: string[] = []
    const agentStream = await h.caller.terminal.onData({ sessionId: agent.sessionId })
    const agentSub = agentStream.subscribe({
      next: (event) => {
        if (event.type === "data") agentChunks.push(event.chunk)
      },
    })
    await waitFor(() => agentChunks.join("").includes("AGENT-ENV:shared-login-environment"))
    agentSub.unsubscribe()

    const terminal = await h.caller.workspaces.spawnTerminal({
      workspaceId: agent.workspaceId,
      cols: 80,
      rows: 24,
    })
    const terminalChunks: string[] = []
    const terminalStream = await h.caller.terminal.onData({ sessionId: terminal.sessionId })
    const terminalSub = terminalStream.subscribe({
      next: (event) => {
        if (event.type === "data") terminalChunks.push(event.chunk)
      },
    })
    await h.caller.terminal.write({
      sessionId: terminal.sessionId,
      data: "printf 'TERM-ENV:%s\\n' \"$PI_LAB_ENV_PARITY\"\r",
    })
    await waitFor(() => terminalChunks.join("").includes("TERM-ENV:shared-login-environment"))
    terminalSub.unsubscribe()
    await h.caller.terminal.kill({ sessionId: terminal.sessionId })
  })

  test("the public launch path renders and durably classifies a stable permission prompt", async () => {
    const result = await h.caller.sessions.start({
      projectId,
      agentId: PERMISSION_AGENT.id,
    })

    await waitFor(() => {
      const durable = h.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.sessionId, result.sessionId))
        .get()
      return durable?.state === "waiting" && durable.waitingReason === "permission"
    })
    await waitFor(() =>
      h.notificationDeliveries.some(
        ({ input }) =>
          input.title === "Agent needs input" && input.body.includes(PERMISSION_AGENT.id),
      ),
    )
    expect(
      h.notificationDeliveries.some(({ input }) => input.title === "Agent finished its turn"),
    ).toBe(false)

    await h.caller.terminal.kill({ sessionId: result.sessionId })
  })

  test("an unfocused app notifies exactly once when a submitted turn returns to its prompt", async () => {
    const result = await h.caller.sessions.start({
      projectId,
      agentId: TURN_COMPLETE_AGENT.id,
    })

    await waitFor(() => {
      const durable = h.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.sessionId, result.sessionId))
        .get()
      return durable?.state === "waiting"
    })
    expect(h.notificationDeliveries).toEqual([])

    // Exercise the public write mutation without a renderer subscription. This
    // both arms the real agent turn and feeds the deterministic agent its input.
    await h.caller.terminal.write({
      sessionId: result.sessionId,
      data: "Implement the selected change\r",
    })
    await waitFor(() =>
      h.notificationDeliveries.some(
        ({ input }) =>
          input.title === "Agent finished its turn" &&
          input.body.includes(TURN_COMPLETE_AGENT.id) &&
          input.silent,
      ),
    )

    const turnDeliveries = h.notificationDeliveries.filter(
      ({ input }) => input.title === "Agent finished its turn",
    )
    expect(turnDeliveries).toHaveLength(1)
    expect(
      h.notificationDeliveries.some(({ input }) => input.title === "Terminal command finished"),
    ).toBe(false)

    const activations: unknown[] = []
    const unsubscribe = h.notifications.activations.subscribe((target) => activations.push(target))
    turnDeliveries[0]?.handlers.onClick()
    expect(activations).toEqual([
      {
        type: "agent",
        projectId,
        workspaceId: result.workspaceId,
        sessionId: result.sessionId,
        agentId: TURN_COMPLETE_AGENT.id,
      },
    ])
    unsubscribe()

    await h.caller.terminal.kill({ sessionId: result.sessionId })
  })

  test("a long-lived agent makes the 2nd start (same project) a 'worktree'; another project stays 'branch'", async () => {
    // First start: branch (main checkout), held live by the long agent.
    const first = await h.caller.sessions.start({ projectId, agentId: "long-fake-agent" })
    expect(first.kind).toBe("branch")
    await waitFor(() => h.activityMonitor.liveAgentCount(projectId) === 1)

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

  test("a non-Git project permits one main agent but rejects worktrees and a concurrent agent", async () => {
    const plain = await mkdtemp(join(tmpdir(), "pi-lab-plain-agent-"))
    const plainProject = await h.caller.projects.open({ path: plain })

    await expect(
      h.caller.sessions.start({
        projectId: plainProject.id,
        agentId: "fake-agent",
        workspaceMode: "worktree",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("Initialize Git"),
    })

    const first = await h.caller.sessions.start({
      projectId: plainProject.id,
      agentId: "long-fake-agent",
    })
    expect(first.kind).toBe("branch")
    await waitFor(() => h.activityMonitor.liveAgentCount(plainProject.id) === 1)

    await expect(
      h.caller.sessions.start({
        projectId: plainProject.id,
        agentId: "fake-agent",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("one agent"),
    })

    await h.caller.terminal.kill({ sessionId: first.sessionId })
  })

  test("simultaneous non-Git starts cannot race into two live agents", async () => {
    const plain = await mkdtemp(join(tmpdir(), "pi-lab-plain-agent-race-"))
    const plainProject = await h.caller.projects.open({ path: plain })

    const results = await Promise.allSettled([
      h.caller.sessions.start({
        projectId: plainProject.id,
        agentId: "long-fake-agent",
      }),
      h.caller.sessions.start({
        projectId: plainProject.id,
        agentId: "long-fake-agent",
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

  test("a source-file-bound launch stays in the main checkout despite a live agent", async () => {
    const first = await h.caller.sessions.start({ projectId, agentId: "long-fake-agent" })
    await waitFor(() => h.activityMonitor.liveAgentCount(projectId) === 1)

    const taskAgent = await h.caller.sessions.start({
      projectId,
      agentId: "fake-agent",
      workspaceMode: "main",
    })

    expect(taskAgent.kind).toBe("branch")
    expect(taskAgent.workspaceId).toBe(first.workspaceId)
    const workspace = await h.caller.workspaces.get({ id: taskAgent.workspaceId })
    expect(workspaceWorkingDir(h.db, workspace)).toBe(h.repoDir)
    await h.caller.terminal.kill({ sessionId: first.sessionId })
  })
})

describe("sessions.startAutoResearch — placeholder worktree launch", () => {
  test("creates a worktree workspace and seeds AUTORESEARCH.md into it", async () => {
    // Remember a launchable test agent so the default (`claude-code`, absent from
    // the harness catalog) isn't resolved.
    await h.caller.agents.setProjectChoice({ projectId, agentId: "fake-agent" })

    const result = await h.caller.sessions.startAutoResearch({ projectId })

    // The session runs in a fresh worktree, never the project's main checkout.
    expect(result.kind).toBe("worktree")
    expect(result.sessionId).toBeTruthy()
    const workspace = await h.caller.workspaces.get({ id: result.workspaceId })
    expect(workspace.kind).toBe("worktree")
    const dir = workspaceWorkingDir(h.db, workspace)
    expect(dir).not.toBe(h.repoDir)
    expect(existsSync(dir)).toBe(true)

    // The placeholder file lands inside that worktree's working dir. It is seeded
    // BEFORE the agent spawns, so it already exists the moment the call resolves.
    const seeded = join(dir, "AUTORESEARCH.md")
    expect(existsSync(seeded)).toBe(true)
    expect(readFileSync(seeded, "utf8")).toContain("placeholder")

    // The launch is durably recorded against the project's remembered/default agent.
    const durable = h.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.sessionId, result.sessionId))
      .get()
    expect(durable).toMatchObject({ projectId, workspaceId: result.workspaceId })
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

  test("a source-file-bound launch still uses the main checkout", async () => {
    enableWorktreePerAgent()

    const result = await h.caller.sessions.start({
      projectId,
      agentId: "fake-agent",
      workspaceMode: "main",
    })

    expect(result.kind).toBe("branch")
    const workspace = await h.caller.workspaces.get({ id: result.workspaceId })
    expect(workspaceWorkingDir(h.db, workspace)).toBe(h.repoDir)
  })
})

describe("sessions.start — registry drains on exit", () => {
  test("after a session exits the next start is 'branch' again, reusing the one branch workspace", async () => {
    // Hold a live agent so a 2nd start would be a worktree.
    const live = await h.caller.sessions.start({ projectId, agentId: "long-fake-agent" })
    expect(live.kind).toBe("branch")
    await waitFor(() => h.activityMonitor.liveAgentCount(projectId) === 1)

    const second = await h.caller.sessions.start({ projectId, agentId: "fake-agent" })
    expect(second.kind).toBe("worktree")

    // Kill the long-lived session; the registry drains via the daemon exit event.
    await h.caller.terminal.kill({ sessionId: live.sessionId })
    await waitFor(() => h.activityMonitor.liveAgentCount(projectId) === 0)

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

  test("a fresh app-lifetime monitor reconciles a durable still-live daemon session", async () => {
    const live = await h.caller.sessions.start({
      projectId,
      agentId: LONG_FAKE_AGENT.id,
    })
    h.activityMonitor.dispose()

    const recoveredClient = new DaemonClient(join(h.dataDir, "daemon.sock"))
    await recoveredClient.connect()
    const recoveredRegistry = new ActivityRegistry({
      clock: systemActivityClock,
      scheduler: systemActivityScheduler,
    })
    const recoveredMonitor = createActivityMonitor({
      db: h.db,
      registry: recoveredRegistry,
      getMonitorClient: async () => recoveredClient,
      notifications: h.notificationService,
      scheduler: systemActivityScheduler,
      logger: { warn: () => {} },
    })

    await recoveredMonitor.reconcile()
    expect(recoveredRegistry.get(live.sessionId)).toMatchObject({
      sessionId: live.sessionId,
      projectId,
      workspaceId: live.workspaceId,
      state: "working",
    })

    await h.caller.terminal.kill({ sessionId: live.sessionId })
    recoveredMonitor.dispose()
    recoveredRegistry.dispose()
    recoveredClient.close()
  })
})
