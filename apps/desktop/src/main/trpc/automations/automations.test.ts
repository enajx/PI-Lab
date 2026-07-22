// Integration tests for the automations router (AGENTS.md "Scope" / md/engineering/testing-and-build.md): createCaller
// over a temp SQLite DB with real migrations, a real temp git repo, and the
// in-process pty-daemon + fake agent. Covers CRUD, prompt-version snapshotting,
// the computed nextRunAt, runNow firing through the real session-start flow, and
// the scheduler firing a due automation via the SAME dispatch path.
import { agentSessions, automationRuns, automations } from "@pi-lab/local-db"
import type { TerminalAgent } from "@pi-lab/shared"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { dispatchAutomation } from "../../automations/dispatch"
import type {
  NonInteractiveProcessResult,
  NonInteractiveProcessRunner,
} from "../../automations/nonInteractiveRunner"
import { AutomationScheduler } from "../../automations/scheduler"
import { createNotificationBrokers } from "../../notifications"
import type { AppContext } from "../context"
import { createHarness, FAKE_AGENT, type Harness } from "../testHarness"

const DAILY_9 = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0"
const WORKFLOW_AGENT: TerminalAgent = {
  id: "workflow-agent",
  label: "Workflow Agent",
  command: process.execPath,
  detect: "node",
  defaultArgs: [
    "-e",
    "process.stdout.write('Working on it\\n');setTimeout(()=>process.stdout.write('\\n❯\\n'),25);process.stdin.resume()",
  ],
}
const CODEX_ONE_SHOT_AGENT: TerminalAgent = {
  id: "codex",
  label: "Codex",
  command: "/custom/codex",
  detect: "codex",
  defaultArgs: ["--profile", "science"],
  env: { AGENT_ENV: "kept" },
}

let h: Harness
let projectId: string

beforeEach(async () => {
  h = await createHarness([FAKE_AGENT, WORKFLOW_AGENT])
  const project = await h.caller.projects.open({ path: h.repoDir })
  projectId = project.id
})

afterEach(async () => {
  await h.dispose()
})

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("waitFor timed out")
}

async function resetHarness(
  agents: readonly TerminalAgent[],
  runNonInteractiveProcess: NonInteractiveProcessRunner,
): Promise<void> {
  await h.dispose()
  h = await createHarness(agents, {
    runNonInteractiveProcess,
    getAgentLaunchEnvironment: async () => ({
      PATH: "/login/bin",
      LOGIN_ENV: "resolved",
    }),
    notificationsUnfocused: true,
    nativeNotificationsSupported: true,
  })
  const project = await h.caller.projects.open({ path: h.repoDir })
  projectId = project.id
}

/** The AppContext the harness built, for direct dispatch/scheduler tests. */
function harnessContext(): AppContext {
  return {
    db: h.db,
    skillsHomeDir: h.skillsHomeDir,
    getDaemonClient: async () => h.client,
    agentCatalog: [FAKE_AGENT, WORKFLOW_AGENT],
    resolveAgentExecutable: async (candidate) => candidate,
    getAgentLaunchEnvironment: async () => ({ ...process.env }) as Record<string, string>,
    runNonInteractiveProcess: async () => {
      throw new Error("interactive test unexpectedly ran a one-shot workflow")
    },
    credentialCipher: { encrypt: (value) => value },
    sshExec: async () => ({ ok: true, detail: "" }),
    httpFetch: async () => {
      throw new Error("no network in tests")
    },
    openPath: async () => "",
    pyToolsExec: async () => ({ stdout: "", stderr: "", code: null, notFound: true }),
    discoverPythonEnvironments: async () => [],
    resolvePythonRuntime: async () => ({
      source: null,
      displayName: "No virtual env",
      interpreterPath: process.execPath,
      runStrategy: { kind: "python", command: process.execPath, argsPrefix: [] },
    }),
    notifications: createNotificationBrokers(),
    activityMonitor: h.activityMonitor,
    notificationService: h.notificationService,
    caffeine: h.caffeine,
  }
}

function nonInteractiveHarnessContext(runner: NonInteractiveProcessRunner): AppContext {
  return {
    ...harnessContext(),
    agentCatalog: [CODEX_ONE_SHOT_AGENT],
    runNonInteractiveProcess: runner,
  }
}

describe("automations CRUD", () => {
  test("create validates the rule, computes nextRunAt, and snapshots the prompt", async () => {
    const created = await h.caller.automations.create({
      projectId,
      agentId: "fake-agent",
      name: "Nightly",
      prompt: "do the nightly thing",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })

    expect(created.name).toBe("Nightly")
    expect(created.enabled).toBe(true)
    expect(created.nextRunAt).toBeGreaterThan(Date.now())
    expect(created.scheduleSummary).toContain("Daily")

    // The prompt was snapshotted as the first version.
    const versions = await h.caller.automations.listPromptVersions({ automationId: created.id })
    expect(versions).toHaveLength(1)
    expect(versions[0]?.prompt).toBe("do the nightly thing")
    expect(versions[0]?.origin).toBe("edit")
  })

  test("create rejects an invalid recurrence rule", async () => {
    await expect(
      h.caller.automations.create({
        projectId,
        agentId: "fake-agent",
        name: "Bad",
        recurrenceRule: "not-a-rule",
        timezone: "UTC",
      }),
    ).rejects.toThrow(/recurrence/i)
  })

  test("create with enabled:false leaves nextRunAt null", async () => {
    const created = await h.caller.automations.create({
      projectId,
      agentId: "fake-agent",
      name: "Paused",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
      enabled: false,
    })
    expect(created.enabled).toBe(false)
    expect(created.nextRunAt).toBeNull()
  })

  test("create and update persist the selected execution mode", async () => {
    const created = await h.caller.automations.create({
      projectId,
      agentId: "fake-agent",
      executionMode: "noninteractive",
      name: "One shot",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })
    expect(created.executionMode).toBe("noninteractive")
    expect((await h.caller.automations.list())[0]?.executionMode).toBe("noninteractive")

    const updated = await h.caller.automations.update({
      id: created.id,
      executionMode: "interactive",
    })
    expect(updated.executionMode).toBe("interactive")
  })

  test("listRuns includes an exact target older than the requested page", async () => {
    const created = await h.caller.automations.create({
      projectId,
      agentId: "fake-agent",
      name: "History",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })
    h.db
      .insert(automationRuns)
      .values(
        Array.from({ length: 25 }, (_, index) => ({
          id: `history-run-${index}`,
          automationId: created.id,
          scheduledFor: 1_900_000_000_000 + index,
          createdAt: 1_900_000_000_000 + index,
        })),
      )
      .run()

    const runs = await h.caller.automations.listRuns({
      automationId: created.id,
      limit: 20,
      targetRunId: "history-run-0",
    })

    expect(runs).toHaveLength(21)
    expect(runs.at(-1)?.id).toBe("history-run-0")
  })

  test("list returns created automations newest-first", async () => {
    const first = await h.caller.automations.create({
      projectId,
      agentId: "fake-agent",
      name: "First",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })
    // Bump the second row's createdAt so the desc(createdAt) order is stable even
    // when both inserts land in the same millisecond.
    h.db
      .update(automations)
      .set({ createdAt: first.createdAt + 1000 })
      .where(eq(automations.id, first.id))
      .run()
    await h.caller.automations.create({
      projectId,
      agentId: "fake-agent",
      name: "Second",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })
    const list = await h.caller.automations.list()
    expect(list).toHaveLength(2)
    // "First" was pushed to the newest createdAt above, so it sorts first.
    expect(list[0]?.name).toBe("First")
    expect(list.map((a) => a.name).sort()).toEqual(["First", "Second"])
  })

  test("update re-snapshots the prompt and recomputes nextRunAt on rule change", async () => {
    const created = await h.caller.automations.create({
      projectId,
      agentId: "fake-agent",
      name: "Job",
      prompt: "v1",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })

    const updated = await h.caller.automations.update({
      id: created.id,
      prompt: "v2",
      recurrenceRule: "FREQ=HOURLY",
    })
    expect(updated.prompt).toBe("v2")
    expect(updated.scheduleSummary).toBe("Hourly")
    expect(updated.nextRunAt).toBeGreaterThan(Date.now())

    const versions = await h.caller.automations.listPromptVersions({ automationId: created.id })
    expect(versions.map((v) => v.prompt)).toEqual(["v2", "v1"]) // newest first
  })

  test("setEnabled toggles and recomputes nextRunAt on resume", async () => {
    const created = await h.caller.automations.create({
      projectId,
      agentId: "fake-agent",
      name: "Toggle",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })

    const off = await h.caller.automations.setEnabled({ id: created.id, enabled: false })
    expect(off.enabled).toBe(false)
    expect(off.nextRunAt).toBeNull()

    const on = await h.caller.automations.setEnabled({ id: created.id, enabled: true })
    expect(on.enabled).toBe(true)
    expect(on.nextRunAt).toBeGreaterThan(Date.now())
  })

  test("delete removes the automation (and cascades its runs/versions)", async () => {
    const created = await h.caller.automations.create({
      projectId,
      agentId: "fake-agent",
      name: "Doomed",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })
    await h.caller.automations.delete({ id: created.id })
    await expect(h.caller.automations.get({ id: created.id })).rejects.toThrow(/No automation/)
    const list = await h.caller.automations.list()
    expect(list).toHaveLength(0)
  })

  test("previewSchedule returns a summary and upcoming occurrences", async () => {
    const preview = await h.caller.automations.previewSchedule({
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })
    expect(preview.valid).toBe(true)
    expect(preview.summary).toContain("Daily")
    expect(preview.upcoming).toHaveLength(5)
    // strictly increasing
    const sorted = [...preview.upcoming].sort((a, b) => a - b)
    expect(preview.upcoming).toEqual(sorted)
    expect(new Set(preview.upcoming).size).toBe(preview.upcoming.length)

    const invalid = await h.caller.automations.previewSchedule({
      recurrenceRule: "garbage",
      timezone: "UTC",
    })
    expect(invalid.valid).toBe(false)
    expect(invalid.upcoming).toHaveLength(0)
  })
})

describe("runNow — fires via the real session-start flow", () => {
  test("tracks the initially launched interactive turn through completion", async () => {
    const created = await h.caller.automations.create({
      projectId,
      agentId: WORKFLOW_AGENT.id,
      name: "Manual",
      prompt: "go",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })

    const { runId } = await h.caller.automations.runNow({ id: created.id })
    expect(runId).toBeTruthy()

    await waitFor(
      () =>
        h.db
          .select()
          .from(automationRuns)
          .where(eq(automationRuns.id, runId ?? ""))
          .get()?.state === "completed",
    )
    const runs = await h.caller.automations.listRuns({ automationId: created.id })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.state).toBe("completed")
    expect(runs[0]?.workspaceId).toBeTruthy()
    expect(runs[0]?.sessionId).toBeTruthy()
    expect(runs[0]?.completedAt).toEqual(expect.any(Number))

    // runNow uses a fresh scheduledFor and never touches the cadence.
    const after = await h.caller.automations.get({ id: created.id })
    expect(after.nextRunAt).toBe(created.nextRunAt)
  })

  test("a failed launch (unknown agent) records a 'failed' run", async () => {
    // Seed an automation referencing an agent not in the catalog.
    const row = h.db
      .insert(automations)
      .values({
        projectId,
        agentId: "missing-agent",
        name: "BadAgent",
        recurrenceRule: DAILY_9,
        startAt: Date.now(),
        timezone: "UTC",
      })
      .returning()
      .get()

    const { runId } = await h.caller.automations.runNow({ id: row.id })
    expect(runId).toBeTruthy()

    const runs = await h.caller.automations.listRuns({ automationId: row.id })
    expect(runs[0]?.state).toBe("failed")
    expect(runs[0]?.error).toMatch(/agent/i)
  })
})

describe("runNow — non-interactive process lifecycle", () => {
  test("runs exact argv in the active project and routes start/completion to the exact run", async () => {
    let finish: (result: NonInteractiveProcessResult) => void = () => {}
    const completion = new Promise<NonInteractiveProcessResult>((resolve) => {
      finish = resolve
    })
    const runner = vi.fn<NonInteractiveProcessRunner>(async () => ({ completion }))
    await resetHarness([CODEX_ONE_SHOT_AGENT], runner)
    await h.caller.settings.updateNotifications({
      workflowStart: { enabled: true },
    })
    const created = await h.caller.automations.create({
      projectId,
      agentId: "codex",
      executionMode: "noninteractive",
      name: "Review",
      prompt: "review; $(touch never)",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })

    const { runId } = await h.caller.automations.runNow({ id: created.id })
    expect(runId).toBeTruthy()
    expect(runner).toHaveBeenCalledWith({
      command: "/custom/codex",
      args: [
        "exec",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "review; $(touch never)",
      ],
      cwd: h.repoDir,
      env: expect.objectContaining({
        PATH: "/login/bin",
        LOGIN_ENV: "resolved",
        AGENT_ENV: "kept",
      }),
    })
    expect(
      h.db
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.id, runId ?? ""))
        .get(),
    ).toMatchObject({
      state: "running",
      workspaceId: null,
      sessionId: null,
    })
    expect(h.db.select().from(agentSessions).all()).toHaveLength(0)
    expect(h.notificationDeliveries.map((delivery) => delivery.input.title)).toEqual([
      "Workflow started",
    ])

    finish({ code: 0, signal: null, error: null, stdout: "", stderr: "" })
    await waitFor(
      () =>
        h.db
          .select()
          .from(automationRuns)
          .where(eq(automationRuns.id, runId ?? ""))
          .get()?.state === "completed",
    )
    expect(h.notificationDeliveries.map((delivery) => delivery.input.title)).toEqual([
      "Workflow started",
      "Workflow completed",
    ])

    const activations: unknown[] = []
    const unsubscribe = h.notifications.activations.subscribe((target) => activations.push(target))
    h.notificationDeliveries[1]?.handlers.onClick()
    unsubscribe()
    expect(activations).toEqual([{ type: "workflow", workflowId: created.id, runId }])
  })

  test("uses the actual exit code and stderr for one failure notification", async () => {
    const runner: NonInteractiveProcessRunner = async () => ({
      completion: Promise.resolve({
        code: 17,
        signal: null,
        error: null,
        stdout: "",
        stderr: "model unavailable",
      }),
    })
    await resetHarness([CODEX_ONE_SHOT_AGENT], runner)
    const created = await h.caller.automations.create({
      projectId,
      agentId: "codex",
      executionMode: "noninteractive",
      name: "Failing review",
      prompt: "review",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })

    const { runId } = await h.caller.automations.runNow({ id: created.id })
    await waitFor(
      () =>
        h.db
          .select()
          .from(automationRuns)
          .where(eq(automationRuns.id, runId ?? ""))
          .get()?.state === "failed",
    )
    const run = h.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, runId ?? ""))
      .get()
    expect(run?.error).toMatch(/code 17.*model unavailable/i)
    expect(h.notificationDeliveries.map((delivery) => delivery.input.title)).toEqual([
      "Workflow failed",
    ])
  })

  test("uses the same configured executable override as interactive agent launches", async () => {
    const runner = vi.fn<NonInteractiveProcessRunner>(async () => ({
      completion: Promise.resolve({ code: 0, signal: null, error: null, stdout: "", stderr: "" }),
    }))
    await resetHarness([CODEX_ONE_SHOT_AGENT], runner)
    await h.caller.settings.updateAgents({
      executableOverrides: { codex: "/configured/codex" },
    })
    const created = await h.caller.automations.create({
      projectId,
      agentId: "codex",
      executionMode: "noninteractive",
      name: "Configured",
      prompt: "review",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })

    await h.caller.automations.runNow({ id: created.id })

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/configured/codex",
        args: [
          "exec",
          "--skip-git-repo-check",
          "--dangerously-bypass-approvals-and-sandbox",
          "review",
        ],
      }),
    )
  })

  test("surfaces an unavailable harness without inventing a started event", async () => {
    const runner = vi.fn<NonInteractiveProcessRunner>()
    await resetHarness([{ ...CODEX_ONE_SHOT_AGENT, command: "/missing/pi-lab-agent" }], runner)
    const created = await h.caller.automations.create({
      projectId,
      agentId: "codex",
      executionMode: "noninteractive",
      name: "Unavailable",
      prompt: "review",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })

    const { runId } = await h.caller.automations.runNow({ id: created.id })
    const run = h.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, runId ?? ""))
      .get()
    expect(run).toMatchObject({ state: "failed" })
    expect(run?.error).toMatch(/not available.*settings/i)
    expect(runner).not.toHaveBeenCalled()
    expect(h.notificationDeliveries.map((delivery) => delivery.input.title)).toEqual([
      "Workflow failed",
    ])
  })

  test("surfaces a spawn failure without inventing a started event", async () => {
    const runner: NonInteractiveProcessRunner = async () => {
      throw new Error("Unable to start /custom/codex: spawn EACCES")
    }
    await resetHarness([CODEX_ONE_SHOT_AGENT], runner)
    await h.caller.settings.updateNotifications({
      workflowStart: { enabled: true },
    })
    const created = await h.caller.automations.create({
      projectId,
      agentId: "codex",
      executionMode: "noninteractive",
      name: "Cannot spawn",
      prompt: "review",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })

    const { runId } = await h.caller.automations.runNow({ id: created.id })
    const run = h.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, runId ?? ""))
      .get()
    expect(run).toMatchObject({
      state: "failed",
      launchedAt: null,
      error: "Unable to start /custom/codex: spawn EACCES",
    })
    expect(h.notificationDeliveries.map((delivery) => delivery.input.title)).toEqual([
      "Workflow failed",
    ])
  })

  test.each([
    {
      label: "signal termination",
      result: {
        code: null,
        signal: "SIGTERM" as NodeJS.Signals,
        error: null,
        stdout: "",
        stderr: "",
      },
      expectedError: /signal SIGTERM/i,
    },
    {
      label: "post-spawn runtime error",
      result: {
        code: null,
        signal: null,
        error: "Codex process stream failed",
        stdout: "",
        stderr: "",
      },
      expectedError: /process failed.*stream failed/i,
    },
  ])("fails once on $label", async ({ result, expectedError }) => {
    const runner: NonInteractiveProcessRunner = async () => ({
      completion: Promise.resolve(result),
    })
    await resetHarness([CODEX_ONE_SHOT_AGENT], runner)
    const created = await h.caller.automations.create({
      projectId,
      agentId: "codex",
      executionMode: "noninteractive",
      name: "Interrupted",
      prompt: "review",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })

    const { runId } = await h.caller.automations.runNow({ id: created.id })
    await waitFor(
      () =>
        h.db
          .select()
          .from(automationRuns)
          .where(eq(automationRuns.id, runId ?? ""))
          .get()?.state === "failed",
    )
    const run = h.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, runId ?? ""))
      .get()
    expect(run?.error).toMatch(expectedError)
    expect(h.notificationDeliveries.map((delivery) => delivery.input.title)).toEqual([
      "Workflow failed",
    ])
  })
})

describe("dispatch overlap guard", () => {
  test("a second dispatch for the same scheduledFor is a no-op", async () => {
    const ctx = harnessContext()
    const automation = h.db
      .insert(automations)
      .values({
        projectId,
        agentId: WORKFLOW_AGENT.id,
        name: "Once",
        recurrenceRule: DAILY_9,
        startAt: Date.now(),
        timezone: "UTC",
      })
      .returning()
      .get()

    const scheduledFor = 1_900_000_000_000
    const first = await dispatchAutomation(ctx, { automation, scheduledFor })
    const second = await dispatchAutomation(ctx, { automation, scheduledFor })

    expect(first).not.toBeNull()
    expect(second).toBeNull() // claimed already

    const runs = await h.caller.automations.listRuns({ automationId: automation.id })
    expect(runs).toHaveLength(1)
  })
})

describe("scheduler fires a due automation end-to-end", () => {
  test("with an injected clock + the real dispatch fire, fires once and advances nextRunAt", async () => {
    const ctx = harnessContext()
    const created = await h.caller.automations.create({
      projectId,
      agentId: WORKFLOW_AGENT.id,
      name: "Due",
      prompt: "tick",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })
    const due = created.nextRunAt
    expect(due).not.toBeNull()

    // A clock just past the due instant; fire is the real dispatcher.
    const scheduler = new AutomationScheduler({
      db: h.db,
      fire: (args) => dispatchAutomation(ctx, args),
      now: () => (due ?? 0) + 60_000,
    })

    const fired = await scheduler.tick()
    expect(fired).toBe(1)

    await waitFor(
      () =>
        h.db.select().from(automationRuns).where(eq(automationRuns.automationId, created.id)).get()
          ?.state === "completed",
    ).catch(() => {
      const current = h.db
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.automationId, created.id))
        .get()
      throw new Error(`workflow remained ${current?.state}: ${current?.error ?? "no error"}`)
    })
    const runs = await h.caller.automations.listRuns({ automationId: created.id })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.state).toBe("completed")
    expect(runs[0]?.scheduledFor).toBe(due)

    // nextRunAt advanced past the fired occurrence.
    const reloaded = h.db.select().from(automations).where(eq(automations.id, created.id)).get()
    expect(reloaded?.nextRunAt).toBeGreaterThan(due ?? 0)
  })

  test("a disabled automation is never fired by the scheduler", async () => {
    const ctx = harnessContext()
    const created = await h.caller.automations.create({
      projectId,
      agentId: "fake-agent",
      name: "Off",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
      enabled: false,
    })

    const scheduler = new AutomationScheduler({
      db: h.db,
      fire: (args) => dispatchAutomation(ctx, args),
      now: () => Date.now() + 10 * 24 * 60 * 60 * 1000, // far in the future
    })
    const fired = await scheduler.tick()
    expect(fired).toBe(0)

    const runs = await h.caller.automations.listRuns({ automationId: created.id })
    expect(runs).toHaveLength(0)
  })

  test("a scheduled run-to-completion workflow follows its process lifecycle", async () => {
    const runner = vi.fn<NonInteractiveProcessRunner>(async () => ({
      completion: Promise.resolve({
        code: 0,
        signal: null,
        error: null,
        stdout: "",
        stderr: "",
      }),
    }))
    await resetHarness([CODEX_ONE_SHOT_AGENT], runner)
    await h.caller.settings.updateNotifications({
      workflowStart: { enabled: true },
    })
    const created = await h.caller.automations.create({
      projectId,
      agentId: CODEX_ONE_SHOT_AGENT.id,
      executionMode: "noninteractive",
      name: "Scheduled one-shot",
      prompt: "review",
      recurrenceRule: DAILY_9,
      timezone: "UTC",
    })
    const due = created.nextRunAt
    expect(due).not.toBeNull()

    const scheduler = new AutomationScheduler({
      db: h.db,
      fire: (args) => dispatchAutomation(nonInteractiveHarnessContext(runner), args),
      now: () => (due ?? 0) + 60_000,
    })
    const fired = await scheduler.tick()
    expect(fired).toBe(1)
    await waitFor(
      () =>
        h.db.select().from(automationRuns).where(eq(automationRuns.automationId, created.id)).get()
          ?.state === "completed",
    )

    expect(runner).toHaveBeenCalledTimes(1)
    expect(h.notificationDeliveries.map((delivery) => delivery.input.title)).toEqual([
      "Workflow started",
      "Workflow completed",
    ])
  })
})
