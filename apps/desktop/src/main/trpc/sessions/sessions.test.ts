// Integration tests for the start-agent-session policy:
// createCaller over a temp SQLite DB with real migrations, real temp git repos,
// an in-process pty-daemon, and injected fake agents (one short-lived, one
// long-lived so a session can be held open across a second start). Full cleanup
// per test; concurrency assertions poll with timeouts, never fixed sleeps.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentSessions, settings, worktrees } from "@pi-lab/local-db"
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
import { runGit } from "../../git"
import { createHarness, FAKE_AGENT, type Harness, LONG_FAKE_AGENT, makeRepo } from "../testHarness"
import { findSkill } from "../workflows/planResearchSkill"
import { workspaceWorkingDir } from "../workspaces"

/**
 * Give a test paper folder a `main.tex` when it has no .tex file at its top level,
 * since PI Lab only accepts folders that can be a paper. Returns the link input unchanged.
 */
function withTex<T extends { dir: string }>(input: T): T {
  if (!readdirSync(input.dir).some((name) => name.endsWith(".tex"))) {
    writeFileSync(join(input.dir, "main.tex"), "\\documentclass{article}\n")
  }
  return input
}

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

/** Prints its own arguments and stays alive, so a test can read the launch argv. */
const ARGV_AGENT: TerminalAgent = {
  id: "argv-agent",
  label: "Argv Agent",
  command: process.execPath,
  detect: "node",
  defaultArgs: [
    "-e",
    "process.stdout.write('ARGV:'+JSON.stringify(process.argv.slice(1))+':END');setInterval(()=>{},1000)",
    "--",
  ],
  addDirArg: "--add-dir",
}

beforeEach(async () => {
  h = await createHarness(
    [
      ARGV_AGENT,
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
  test("title bar status lists live sessions with their agent, project, and state", async () => {
    h.activityRegistry.register({
      sessionId: "live-status-session",
      projectId,
      workspaceId: null,
      agentId: LONG_FAKE_AGENT.id,
      workflowRunId: null,
      origin: "project",
      turnArmed: true,
    })
    let status: unknown
    const stream = await h.caller.sessions.onStatus()
    const subscription = stream.subscribe({
      next: (sessions) => {
        status = sessions
      },
    })
    subscription.unsubscribe()
    expect(status).toContainEqual({
      sessionId: "live-status-session",
      projectId,
      projectName: expect.any(String),
      agentId: LONG_FAKE_AGENT.id,
      workspaceId: null,
      origin: "project",
      state: "working",
    })
  })

  test("no prior agent -> kind 'branch', cwd is the repo root, agent runs", async () => {
    const result = await h.caller.sessions.start({
      origin: "project",
      projectId,
      agentId: "fake-agent",
    })

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
      origin: "project",
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
      origin: "project",
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
      origin: "project",
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
      origin: "project",
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
        origin: "project",
      },
    ])
    unsubscribe()

    await h.caller.terminal.kill({ sessionId: result.sessionId })
  })

  test("overlapping starts reserve main once through activity registration", async () => {
    const results = await Promise.all([
      h.caller.sessions.start({ origin: "project", projectId, agentId: LONG_FAKE_AGENT.id }),
      h.caller.sessions.start({ origin: "project", projectId, agentId: LONG_FAKE_AGENT.id }),
    ])
    expect(results.map((result) => result.kind).sort()).toEqual(["branch", "worktree"])
    expect(h.activityMonitor.liveAgentCount(projectId)).toBe(2)
  })

  test("a long-lived agent makes the 2nd start (same project) a 'worktree'; another project stays 'branch'", async () => {
    // First start: branch (main checkout), held live by the long agent.
    const first = await h.caller.sessions.start({
      origin: "project",
      projectId,
      agentId: "long-fake-agent",
    })
    expect(first.kind).toBe("branch")
    await waitFor(() => h.activityMonitor.liveAgentCount(projectId) === 1)

    // A second concurrent start for the SAME project must get its own worktree.
    const second = await h.caller.sessions.start({
      origin: "project",
      projectId,
      agentId: "fake-agent",
    })
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
      origin: "project",
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
        origin: "project",
        projectId: plainProject.id,
        agentId: "fake-agent",
        workspaceMode: "worktree",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("Initialize Git"),
    })

    const first = await h.caller.sessions.start({
      origin: "project",
      projectId: plainProject.id,
      agentId: "long-fake-agent",
    })
    expect(first.kind).toBe("branch")
    await waitFor(() => h.activityMonitor.liveAgentCount(plainProject.id) === 1)

    await expect(
      h.caller.sessions.start({
        origin: "project",
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
        origin: "project",
        projectId: plainProject.id,
        agentId: "long-fake-agent",
      }),
      h.caller.sessions.start({
        origin: "project",
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
    const first = await h.caller.sessions.start({
      origin: "project",
      projectId,
      agentId: "long-fake-agent",
    })
    await waitFor(() => h.activityMonitor.liveAgentCount(projectId) === 1)

    const taskAgent = await h.caller.sessions.start({
      origin: "project",
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
  test("keeps a selected Git subfolder as the agent and seed directory", async () => {
    const selected = join(h.repoDir, "research", "python")
    await mkdir(selected, { recursive: true })
    await writeFile(join(selected, "PROJECT.md"), "# Python project\n")
    await runGit(h.repoDir, ["add", "."])
    await runGit(h.repoDir, ["commit", "-m", "Add nested project"])
    const project = await h.caller.projects.open({ path: selected })
    await h.caller.agents.setProjectChoice({ projectId: project.id, agentId: "fake-agent" })
    const result = await h.caller.sessions.startAutoResearch({ projectId: project.id })
    const workspace = await h.caller.workspaces.get({ id: result.workspaceId })
    const checkout = h.db
      .select()
      .from(worktrees)
      .where(eq(worktrees.id, workspace.worktreeId ?? ""))
      .get()?.path
    if (!checkout) throw new Error("Expected a worktree checkout")
    const expected = join(checkout, "research", "python")
    const live = await h.caller.terminal.list()
    expect(live.find((session) => session.id === result.sessionId)?.cwd).toBe(expected)
    expect(existsSync(join(expected, "AUTORESEARCH.md"))).toBe(true)
    expect(existsSync(join(checkout, "AUTORESEARCH.md"))).toBe(false)
    await h.caller.terminal.kill({ sessionId: result.sessionId })
    await h.caller.workspaces.remove({ id: workspace.id })
    expect(existsSync(checkout)).toBe(false)
  })

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

describe("sessions.startSkill — header skill shortcut", () => {
  test("starts the project's agent with a prompt that triggers the named skill", async () => {
    const skillDir = join(h.repoDir, ".claude", "skills", "review-notes")
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: Review notes\ndescription: Review the lab notes\n---\nReview the notes.\n",
    )
    await h.caller.agents.setProjectChoice({ projectId, agentId: "prompt-agent" })

    const result = await h.caller.sessions.startSkill({
      projectId,
      skillSlug: "review-notes",
      origin: "project",
    })

    expect(result.agentId).toBe("prompt-agent")
    expect(result.label).toBe("Review notes")
    const chunks: string[] = []
    const stream = await h.caller.terminal.onData({ sessionId: result.sessionId })
    const sub = stream.subscribe({
      next: (event) => {
        if (event.type === "data") chunks.push(event.chunk)
      },
    })
    await waitFor(() => chunks.join("").includes("review-notes skill"))
    sub.unsubscribe()
    expect(chunks.join("")).toContain(join(skillDir, "SKILL.md"))
  })

  test("a skill the project does not have is a clear error and starts nothing", async () => {
    await h.caller.agents.setProjectChoice({ projectId, agentId: "prompt-agent" })
    await expect(
      h.caller.sessions.startSkill({ projectId, skillSlug: "missing-skill", origin: "project" }),
    ).rejects.toThrow("missing-skill")
    expect(await h.caller.terminal.list()).toEqual([])
  })

  test("a skill started from the LaTeX Editor is recorded as a LaTeX Editor agent", async () => {
    const skillDir = join(h.repoDir, ".claude", "skills", "review-notes")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: Review notes\n---\nReview.\n")
    await h.caller.agents.setProjectChoice({ projectId, agentId: "prompt-agent" })

    const result = await h.caller.sessions.startSkill({
      projectId,
      skillSlug: "review-notes",
      origin: "latex",
    })

    const row = h.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.sessionId, result.sessionId))
      .get()
    expect(row?.origin).toBe("latex")
  })
})

describe("sessions.startAnalyzeExperiments — Analysis button", () => {
  test("starts the project's agent as an Analysis agent with the analyze-experiments skill", async () => {
    const skillDir = join(h.skillsHomeDir, ".agents", "skills", "analyze-experiments")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "# Analyze experiments\nUSER SKILL TEXT\n")
    await h.caller.agents.setProjectChoice({ projectId, agentId: "prompt-agent" })

    const result = await h.caller.sessions.startAnalyzeExperiments({ projectId })

    expect(result.agentId).toBe("prompt-agent")
    const row = h.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.sessionId, result.sessionId))
      .get()
    expect(row?.origin).toBe("analysis")
    const chunks: string[] = []
    const stream = await h.caller.terminal.onData({ sessionId: result.sessionId })
    const sub = stream.subscribe({
      next: (event) => {
        if (event.type === "data") chunks.push(event.chunk)
      },
    })
    await waitFor(() => chunks.join("").includes("analyze-experiments skill"))
    sub.unsubscribe()
    expect(chunks.join("").replace(/\r?\n/g, "")).toContain(join(skillDir, "SKILL.md"))
  })

  /** Start Analyze experiments and return the agent's output (the prompt), line breaks removed. */
  async function analyzePrompt(): Promise<string> {
    const skillDir = join(h.skillsHomeDir, ".agents", "skills", "analyze-experiments")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "# Analyze experiments\n")
    await h.caller.agents.setProjectChoice({ projectId, agentId: "prompt-agent" })
    const result = await h.caller.sessions.startAnalyzeExperiments({ projectId })
    const chunks: string[] = []
    const stream = await h.caller.terminal.onData({ sessionId: result.sessionId })
    const sub = stream.subscribe({
      next: (event) => {
        if (event.type === "data") chunks.push(event.chunk)
      },
    })
    await waitFor(() => chunks.join("").replace(/\r?\n/g, "").includes("Follow its instructions."))
    sub.unsubscribe()
    return chunks.join("").replace(/\r?\n/g, "")
  }

  test("tells the agent the analysis format from Settings when the project has no override", async () => {
    await h.caller.settings.updateEditor({ analysisFormat: "qmd" })

    const prompt = await analyzePrompt()

    expect(prompt).toContain("Write the analysis as Quarto (.qmd)")
    expect(prompt).not.toContain(".ipynb")
  })

  test("tells the agent the project's own analysis format over the Settings default", async () => {
    await h.caller.settings.updateEditor({ analysisFormat: "qmd" })
    const project = await h.caller.projects.get({ id: projectId })
    await h.caller.projects.updateDetails({
      id: projectId,
      details: {
        name: project.name,
        typeId: "general",
        deadline: null,
        agentId: null,
        analysisFormat: "ipynb",
      },
    })

    const prompt = await analyzePrompt()

    expect(prompt).toContain("Write the analysis as a Jupyter notebook (.ipynb)")
    expect(prompt).not.toContain(".qmd")
  })

  test("PI Lab ships the analyze-experiments placeholder skill", async () => {
    const bundled = join(__dirname, "..", "..", "..", "..", "resources", "skills")
    const skill = await findSkill(
      "analyze-experiments",
      "Analyze experiments",
      "/missing",
      "/missing",
      bundled,
    )
    expect(skill.path).toBe(join(bundled, "analyze-experiments", "SKILL.md"))
    expect(skill.content).toContain("placeholder")
    expect(skill.content).toContain("EXPERIMENTS.md")
    expect(skill.content).toContain("results/")
  })
})

describe("sessions.start — worktreePerAgent ON", () => {
  test("the FIRST start is already a 'worktree'", async () => {
    enableWorktreePerAgent()

    const result = await h.caller.sessions.start({
      origin: "project",
      projectId,
      agentId: "fake-agent",
    })
    expect(result.kind).toBe("worktree")

    const workspace = await h.caller.workspaces.get({ id: result.workspaceId })
    expect(workspace.kind).toBe("worktree")
    expect(existsSync(workspaceWorkingDir(h.db, workspace))).toBe(true)
  })

  test("a source-file-bound launch still uses the main checkout", async () => {
    enableWorktreePerAgent()

    const result = await h.caller.sessions.start({
      origin: "project",
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
    const live = await h.caller.sessions.start({
      origin: "project",
      projectId,
      agentId: "long-fake-agent",
    })
    expect(live.kind).toBe("branch")
    await waitFor(() => h.activityMonitor.liveAgentCount(projectId) === 1)

    const second = await h.caller.sessions.start({
      origin: "project",
      projectId,
      agentId: "fake-agent",
    })
    expect(second.kind).toBe("worktree")

    // Kill the long-lived session; the registry drains via the daemon exit event.
    await h.caller.terminal.kill({ sessionId: live.sessionId })
    await waitFor(() => h.activityMonitor.liveAgentCount(projectId) === 0)

    // The next start is branch again — and reuses the existing single branch
    // workspace (no CONFLICT, same workspace id as the first branch start).
    const third = await h.caller.sessions.start({
      origin: "project",
      projectId,
      agentId: "fake-agent",
    })
    expect(third.kind).toBe("branch")
    expect(third.workspaceId).toBe(live.workspaceId)

    // Exactly one branch workspace exists for the project.
    const all = await h.caller.workspaces.list({ projectId })
    const branchCount = all.filter((w) => w.kind === "branch").length
    expect(branchCount).toBe(1)
  })

  test("a real socket closing during attach preserves the agent and reconnects automatically", async () => {
    const live = await h.caller.sessions.start({
      origin: "project",
      projectId,
      agentId: LONG_FAKE_AGENT.id,
    })
    h.activityMonitor.dispose()
    const brokenClient = new DaemonClient(join(h.dataDir, "daemon.sock"))
    const recoveredClient = new DaemonClient(join(h.dataDir, "daemon.sock"))
    await brokenClient.connect()
    await recoveredClient.connect()
    const attach = brokenClient.attach.bind(brokenClient)
    brokenClient.attach = (sessionId, replay) => {
      const pending = attach(sessionId, replay)
      brokenClient.close()
      return pending
    }
    const recoveredRegistry = new ActivityRegistry({
      clock: systemActivityClock,
      scheduler: systemActivityScheduler,
    })
    let connectionCount = 0
    const monitor = createActivityMonitor({
      db: h.db,
      registry: recoveredRegistry,
      getMonitorClient: async () => (++connectionCount === 1 ? brokenClient : recoveredClient),
      notifications: h.notificationService,
      scheduler: systemActivityScheduler,
      logger: { warn: () => {} },
    })
    try {
      await monitor.reconcile()
      expect(monitor.liveAgentCount(projectId)).toBe(1)
      expect(
        h.db.select().from(agentSessions).where(eq(agentSessions.sessionId, live.sessionId)).get()
          ?.state,
      ).not.toBe("exited")
      await waitFor(() => connectionCount >= 2)
      await recoveredClient.write(live.sessionId, "still alive")
      expect(
        (await recoveredClient.list()).find((session) => session.id === live.sessionId)?.alive,
      ).toBe(true)
      await h.caller.terminal.kill({ sessionId: live.sessionId })
      await waitFor(() => monitor.liveAgentCount(projectId) === 0)
    } finally {
      monitor.dispose()
      recoveredRegistry.dispose()
      brokenClient.close()
      recoveredClient.close()
    }
  })

  test("a fresh app-lifetime monitor reconciles a durable still-live daemon session", async () => {
    const live = await h.caller.sessions.start({
      origin: "project",
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

/** Collect a session's terminal output until it contains `marker`. */
async function outputUntil(sessionId: string, marker: string): Promise<string> {
  const chunks: string[] = []
  const stream = await h.caller.terminal.onData({ sessionId })
  const sub = stream.subscribe({
    next: (event) => {
      if (event.type === "data") chunks.push(event.chunk)
    },
  })
  await waitFor(() => chunks.join("").includes(marker))
  sub.unsubscribe()
  return chunks.join("")
}

/** The argv an {@link ARGV_AGENT} session printed. */
async function launchedArgs(sessionId: string): Promise<string[]> {
  const output = await outputUntil(sessionId, ":END")
  const match = /ARGV:(.*):END/s.exec(output.replace(/\r?\n/g, ""))
  if (!match?.[1]) throw new Error(`No argv in output: ${output}`)
  return JSON.parse(match[1]) as string[]
}

describe("sessions.start — origin view and the paper folder", () => {
  test("records the origin with the session", async () => {
    const result = await h.caller.sessions.start({
      projectId,
      agentId: LONG_FAKE_AGENT.id,
      origin: "latex",
    })
    const row = h.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.sessionId, result.sessionId))
      .get()
    expect(row?.origin).toBe("latex")
  })

  test("a LaTeX Editor agent gets a paper folder outside the project as an extra folder", async () => {
    // The link stores the folder's real path (macOS temp folders live under /private).
    const paperDir = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-paper-outside-")))
    await h.caller.paper.link(withTex({ projectId, dir: paperDir, rootChoice: null }))
    const result = await h.caller.sessions.start({
      projectId,
      agentId: ARGV_AGENT.id,
      origin: "latex",
    })
    expect(await launchedArgs(result.sessionId)).toEqual(["--add-dir", paperDir])
  })

  test("a paper folder inside the project, or a Project view agent, gets no extra folder", async () => {
    const insideDir = join(h.repoDir, "paper")
    await mkdir(insideDir)
    await h.caller.paper.link(withTex({ projectId, dir: insideDir, rootChoice: null }))
    const inside = await h.caller.sessions.start({
      projectId,
      agentId: ARGV_AGENT.id,
      origin: "latex",
    })
    expect(await launchedArgs(inside.sessionId)).toEqual([])
    await h.caller.terminal.kill({ sessionId: inside.sessionId })

    const outsideDir = await mkdtemp(join(tmpdir(), "pi-lab-paper-outside-"))
    await h.caller.paper.link(withTex({ projectId, dir: outsideDir, rootChoice: null }))
    const fromProject = await h.caller.sessions.start({
      projectId,
      agentId: ARGV_AGENT.id,
      origin: "project",
    })
    expect(await launchedArgs(fromProject.sessionId)).toEqual([])
  })

  test("a LaTeX Editor agent in a worktree gets the paper folder inside the project as an extra folder", async () => {
    const insideDir = join(h.repoDir, "paper")
    await mkdir(insideDir)
    await h.caller.paper.link(withTex({ projectId, dir: insideDir, rootChoice: null }))
    const result = await h.caller.sessions.start({
      projectId,
      agentId: ARGV_AGENT.id,
      origin: "latex",
      workspaceMode: "worktree",
    })
    expect(result.kind).toBe("worktree")
    expect(result.warning).toBeNull()
    expect(await launchedArgs(result.sessionId)).toEqual(["--add-dir", await realpath(insideDir)])
  })

  test("an agent without an extra-folder flag still starts, with a warning naming the paper folder", async () => {
    const paperDir = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-paper-outside-")))
    await h.caller.paper.link(withTex({ projectId, dir: paperDir, rootChoice: null }))
    const result = await h.caller.sessions.start({
      projectId,
      agentId: LONG_FAKE_AGENT.id,
      origin: "latex",
    })
    expect(result.warning).toBe(
      `${LONG_FAKE_AGENT.label} cannot be given the paper folder ${paperDir}; it only sees the project folder.`,
    )
    await outputUntil(result.sessionId, "AGENT-LIVE")
  })
})

describe("sessions.projectAgents", () => {
  test("lists only live agents started outside the Project view, with status and last activity", async () => {
    const fromProject = await h.caller.sessions.start({
      projectId,
      agentId: LONG_FAKE_AGENT.id,
      origin: "project",
    })
    expect(await h.caller.sessions.projectAgents({ projectId })).toEqual([])

    h.activityRegistry.register({
      sessionId: "latex-session",
      projectId,
      workspaceId: null,
      agentId: LONG_FAKE_AGENT.id,
      workflowRunId: null,
      origin: "latex",
      turnArmed: true,
    })
    const rows = await h.caller.sessions.projectAgents({ projectId })
    expect(rows).toEqual([
      {
        kind: "agent",
        sessionId: "latex-session",
        agentId: LONG_FAKE_AGENT.id,
        workspaceId: null,
        origin: "latex",
        name: LONG_FAKE_AGENT.label,
        status: "working",
        lastActiveAt: expect.any(Number),
      },
    ])
    expect(
      rows.some((row) => row.kind === "agent" && row.sessionId === fromProject.sessionId),
    ).toBe(false)
  })

  test("lists agents started from Tasks and by a routine, with their workspace", async () => {
    const fromTasks = await h.caller.sessions.start({
      projectId,
      agentId: LONG_FAKE_AGENT.id,
      origin: "tasks",
    })
    h.activityRegistry.register({
      sessionId: "routine-session",
      projectId,
      workspaceId: fromTasks.workspaceId,
      agentId: LONG_FAKE_AGENT.id,
      workflowRunId: null,
      origin: "routine",
      turnArmed: true,
    })
    const rows = await h.caller.sessions.projectAgents({ projectId })
    expect(
      rows.map((row) =>
        row.kind === "agent" ? [row.sessionId, row.origin, row.workspaceId] : [row.kind],
      ),
    ).toEqual([
      [fromTasks.sessionId, "tasks", fromTasks.workspaceId],
      ["routine-session", "routine", fromTasks.workspaceId],
    ])
  })
})
