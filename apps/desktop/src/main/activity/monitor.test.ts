import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  agentSessions,
  automationRuns,
  automations,
  type PiLabDatabase,
  projects,
  runMigrations,
  workspaces,
} from "@pi-lab/local-db"
import type { AttachResult, DataEvent, ExitEvent, SessionInfo } from "@pi-lab/pty-daemon"
import { eq } from "drizzle-orm"
import { describe, expect, onTestFinished, test } from "vitest"
import { EventBroker } from "../notifications/broker"
import { NotificationService } from "../notifications/service"
import type {
  NotificationActivation,
  NotificationDeliveryError,
  NotificationSoundEvent,
} from "../notifications/types"
import { type ActivityDaemonClient, ActivityMonitor } from "./monitor"
import { ActivityRegistry } from "./registry"
import {
  type ActivityClock,
  type ActivityScheduler,
  type ActivityTimer,
  WAITING_CONFIRMATION_MS,
} from "./types"

interface ScheduledTask {
  at: number
  callback: () => void
  cancelled: boolean
}

class ManualTime implements ActivityClock, ActivityScheduler {
  private current = 1_000
  private readonly tasks: ScheduledTask[] = []

  now(): number {
    return this.current
  }

  schedule(delayMs: number, callback: () => void): ActivityTimer {
    const task = { at: this.current + delayMs, callback, cancelled: false }
    this.tasks.push(task)
    return {
      cancel: () => {
        task.cancelled = true
      },
    }
  }

  advance(ms: number): void {
    const target = this.current + ms
    while (true) {
      const next = this.tasks
        .filter((task) => !task.cancelled && task.at <= target)
        .sort((left, right) => left.at - right.at)[0]
      if (!next) break
      next.cancelled = true
      this.current = next.at
      next.callback()
    }
    this.current = target
  }
}

class FakeDaemon implements ActivityDaemonClient {
  private readonly dataListeners: Array<(event: DataEvent) => void> = []
  private readonly exitListeners: Array<(event: ExitEvent) => void> = []
  private readonly closeListeners: Array<() => void> = []
  private liveSessionIds = ["terminal-1"]

  async attach(sessionId: string): Promise<AttachResult> {
    return {
      session: this.session(sessionId),
      scrollback: "➜ repo",
    }
  }

  async list(): Promise<SessionInfo[]> {
    return this.liveSessionIds.map((sessionId) => this.session(sessionId))
  }

  readonly on = (event: "data" | "exit" | "close", listener: unknown): unknown => {
    if (event === "data") this.dataListeners.push(listener as (event: DataEvent) => void)
    if (event === "exit") this.exitListeners.push(listener as (event: ExitEvent) => void)
    if (event === "close") this.closeListeners.push(listener as () => void)
    return this
  }

  emitScreen(screen: string): void {
    this.emitSessionScreen("terminal-1", screen)
  }

  emitSessionScreen(sessionId: string, screen: string): void {
    for (const listener of this.dataListeners) {
      listener({ kind: "data", sessionId, chunk: screen })
    }
  }

  setLiveSessionIds(sessionIds: string[]): void {
    this.liveSessionIds = [...sessionIds]
  }

  private session(id: string): SessionInfo {
    return {
      id,
      command: "/bin/zsh",
      args: [],
      cwd: "/repo",
      cols: 80,
      rows: 24,
      createdAt: 1_000,
      pid: 123,
      alive: true,
    }
  }
}

async function setupTerminalMonitor(): Promise<{
  time: ManualTime
  daemon: FakeDaemon
  deliveries: string[]
  monitor: ActivityMonitor
  registry: ActivityRegistry
}> {
  const time = new ManualTime()
  const daemon = new FakeDaemon()
  const deliveries: string[] = []
  const registry = new ActivityRegistry({ clock: time, scheduler: time })
  const notifications = new NotificationService({
    native: {
      isSupported: () => true,
      deliver: (input) => deliveries.push(input.title),
    },
    focus: { isFocused: () => false, restoreAndFocus: () => {} },
    getPreferences: () => ({
      muted: false,
      agentInput: { enabled: true, sound: "chime" },
      agentTurnCompletion: { enabled: true, sound: "success" },
      terminalCompletion: { enabled: true, sound: "success" },
      workflowStart: { enabled: false, sound: "pulse" },
      workflowCompletion: { enabled: true, sound: "success" },
      workflowFailure: { enabled: true, sound: "alert" },
    }),
    activations: new EventBroker<NotificationActivation>(),
    sounds: new EventBroker<NotificationSoundEvent>(),
    errors: new EventBroker<NotificationDeliveryError>(),
    logger: { warn: () => {} },
  })
  const monitor = new ActivityMonitor({
    db: {} as PiLabDatabase,
    registry,
    getMonitorClient: async () => daemon,
    notifications,
    scheduler: time,
    terminalFactory: () => {
      let screen = ""
      return {
        write: (chunk, callback) => {
          screen = chunk
          callback()
        },
        resize: () => {},
        screen: () => screen,
        cursorLine: () => screen.split("\n").at(-1) ?? "",
        dispose: () => {},
      }
    },
    logger: { warn: () => {} },
  })

  await monitor.trackTerminal({
    sessionId: "terminal-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    label: "Terminal",
    cols: 80,
    rows: 24,
  })
  return { time, daemon, deliveries, monitor, registry }
}

interface AgentMonitorFixture {
  time: ManualTime
  daemon: FakeDaemon
  deliveries: string[]
  db: PiLabDatabase
  registry: ActivityRegistry
  monitor: ActivityMonitor
  createRegistry: () => ActivityRegistry
  createMonitor: (registry: ActivityRegistry) => ActivityMonitor
  dispose: () => void
}

function setupAgentMonitor(): AgentMonitorFixture {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-lab-activity-monitor-"))
  const { db, sqlite } = runMigrations(join(dataDir, "local.db"))
  db.insert(projects).values({ id: "project-1", repoPath: "/repo", name: "Project" }).run()
  db.insert(workspaces)
    .values({
      id: "workspace-1",
      projectId: "project-1",
      kind: "branch",
      name: "main",
      branch: "main",
    })
    .run()

  const time = new ManualTime()
  const daemon = new FakeDaemon()
  const deliveries: string[] = []
  const notifications = new NotificationService({
    native: {
      isSupported: () => true,
      deliver: (input) => deliveries.push(input.title),
    },
    focus: { isFocused: () => false, restoreAndFocus: () => {} },
    getPreferences: () => ({
      muted: false,
      agentInput: { enabled: true, sound: "chime" },
      agentTurnCompletion: { enabled: true, sound: "success" },
      terminalCompletion: { enabled: true, sound: "success" },
      workflowStart: { enabled: false, sound: "pulse" },
      workflowCompletion: { enabled: true, sound: "success" },
      workflowFailure: { enabled: true, sound: "alert" },
    }),
    activations: new EventBroker<NotificationActivation>(),
    sounds: new EventBroker<NotificationSoundEvent>(),
    errors: new EventBroker<NotificationDeliveryError>(),
    logger: { warn: () => {} },
  })
  const registries: ActivityRegistry[] = []
  const monitors: ActivityMonitor[] = []
  const createRegistry = (): ActivityRegistry => {
    const next = new ActivityRegistry({ clock: time, scheduler: time })
    registries.push(next)
    return next
  }
  const createMonitor = (nextRegistry: ActivityRegistry): ActivityMonitor => {
    const next = new ActivityMonitor({
      db,
      registry: nextRegistry,
      getMonitorClient: async () => daemon,
      notifications,
      scheduler: time,
      terminalFactory: () => {
        let screen = ""
        return {
          write: (chunk, callback) => {
            screen = chunk
            callback()
          },
          resize: () => {},
          screen: () => screen,
          cursorLine: () => screen.split("\n").at(-1) ?? "",
          dispose: () => {},
        }
      },
      logger: { warn: () => {} },
    })
    monitors.push(next)
    return next
  }
  const registry = createRegistry()
  const monitor = createMonitor(registry)

  return {
    time,
    daemon,
    deliveries,
    db,
    registry,
    monitor,
    createRegistry,
    createMonitor,
    dispose: () => {
      for (const trackedMonitor of monitors) trackedMonitor.dispose()
      for (const trackedRegistry of registries) trackedRegistry.dispose()
      sqlite.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

describe("ActivityMonitor agent completion notifications", () => {
  test("separates initial workflow completion from later ad-hoc turn completion", async () => {
    const fixture = setupAgentMonitor()
    onTestFinished(fixture.dispose)
    fixture.db
      .insert(automations)
      .values({
        id: "automation-1",
        projectId: "project-1",
        name: "Workflow",
        agentId: "codex",
        recurrenceRule: "FREQ=DAILY",
        timezone: "UTC",
      })
      .run()
    fixture.db
      .insert(automationRuns)
      .values({
        id: "run-1",
        automationId: "automation-1",
        scheduledFor: 1_000,
        state: "pending",
        workspaceId: "workspace-1",
        sessionId: "terminal-1",
      })
      .run()

    await fixture.monitor.track({
      sessionId: "terminal-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      agentId: "codex",
      workflowRunId: "run-1",
      turnArmed: true,
      cols: 80,
      rows: 24,
    })
    fixture.daemon.emitScreen("OpenAI Codex\n\n› ")
    fixture.time.advance(WAITING_CONFIRMATION_MS)
    expect(fixture.deliveries).toEqual(["Workflow completed"])

    fixture.monitor.userInput("terminal-1", "\r")
    fixture.daemon.emitScreen("Finished the follow-up.\nOpenAI Codex\n\n› ")
    fixture.time.advance(WAITING_CONFIRMATION_MS)
    expect(fixture.deliveries).toEqual(["Workflow completed", "Agent finished its turn"])

    fixture.daemon.emitScreen("Finished the follow-up.\nOpenAI Codex\n\n› ")
    fixture.time.advance(WAITING_CONFIRMATION_MS)
    expect(fixture.deliveries).toEqual(["Workflow completed", "Agent finished its turn"])
  })

  test("restores armed and unarmed turns across monitor restart without false completion", async () => {
    const fixture = setupAgentMonitor()
    onTestFinished(fixture.dispose)
    fixture.daemon.setLiveSessionIds(["terminal-1", "terminal-2"])

    await fixture.monitor.track({
      sessionId: "terminal-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      agentId: "claude-code",
      workflowRunId: null,
      turnArmed: false,
      cols: 80,
      rows: 24,
    })
    await fixture.monitor.track({
      sessionId: "terminal-2",
      projectId: "project-1",
      workspaceId: "workspace-1",
      agentId: "codex",
      workflowRunId: null,
      turnArmed: false,
      cols: 80,
      rows: 24,
    })
    fixture.monitor.userInput("terminal-1", "\u001b[13;2u\npasted\ntext")
    fixture.monitor.userInput("terminal-2", "\u0016\n")
    expect(
      fixture.db
        .select({ sessionId: agentSessions.sessionId, turnArmed: agentSessions.turnArmed })
        .from(agentSessions)
        .all(),
    ).toEqual([
      { sessionId: "terminal-1", turnArmed: false },
      { sessionId: "terminal-2", turnArmed: false },
    ])
    fixture.monitor.userInput("terminal-1", "\r")
    expect(
      fixture.db
        .select({ turnArmed: agentSessions.turnArmed })
        .from(agentSessions)
        .where(eq(agentSessions.sessionId, "terminal-1"))
        .get(),
    ).toEqual({ turnArmed: true })

    fixture.monitor.dispose()
    fixture.registry.dispose()
    const recoveredRegistry = fixture.createRegistry()
    const recoveredMonitor = fixture.createMonitor(recoveredRegistry)
    await recoveredMonitor.reconcile()
    expect(recoveredRegistry.get("terminal-1")?.turnArmed).toBe(true)
    expect(recoveredRegistry.get("terminal-2")?.turnArmed).toBe(false)

    fixture.daemon.emitSessionScreen("terminal-2", "OpenAI Codex\n\n› ")
    fixture.time.advance(WAITING_CONFIRMATION_MS)
    expect(fixture.deliveries).toEqual([])

    fixture.daemon.emitSessionScreen("terminal-1", "Claude Code\n\n❯ ")
    fixture.time.advance(WAITING_CONFIRMATION_MS)
    expect(fixture.deliveries).toEqual(["Agent finished its turn"])

    fixture.daemon.emitSessionScreen("terminal-1", "Claude Code\n\n❯ ")
    fixture.time.advance(WAITING_CONFIRMATION_MS)
    expect(fixture.deliveries).toEqual(["Agent finished its turn"])
  })
})

describe("ActivityMonitor terminal command lifecycle", () => {
  test("notifies once only after a non-empty submission returns to a stable prompt", async () => {
    const { time, daemon, deliveries, monitor, registry } = await setupTerminalMonitor()

    monitor.userInput("terminal-1", "\r")
    daemon.emitScreen("➜ repo")
    time.advance(2_000)
    expect(deliveries).toEqual([])

    monitor.userInput("terminal-1", "bun test\r")
    daemon.emitScreen("➜ repo bun test\nrunning tests")
    daemon.emitScreen("➜ repo")
    time.advance(999)
    expect(deliveries).toEqual([])
    time.advance(1)
    expect(deliveries).toEqual(["Terminal command finished"])

    daemon.emitScreen("➜ repo")
    time.advance(2_000)
    expect(deliveries).toEqual(["Terminal command finished"])

    monitor.userInput("terminal-1", "git status\r")
    daemon.emitScreen("clean\n➜ repo")
    time.advance(1_000)
    expect(deliveries).toEqual(["Terminal command finished", "Terminal command finished"])

    monitor.dispose()
    registry.dispose()
  })

  test("does not mistake an echoed silent long-running command for a returned prompt", async () => {
    const { time, daemon, deliveries, monitor, registry } = await setupTerminalMonitor()

    monitor.userInput("terminal-1", "sleep 5\r")
    daemon.emitScreen("➜ repo sleep 5")
    time.advance(2_000)
    expect(deliveries).toEqual([])

    daemon.emitScreen("➜ repo")
    time.advance(999)
    expect(deliveries).toEqual([])
    time.advance(1)
    expect(deliveries).toEqual(["Terminal command finished"])

    monitor.dispose()
    registry.dispose()
  })

  test("does not mistake newline-terminated prompt-shaped program output for the cursor prompt", async () => {
    const { time, daemon, deliveries, monitor, registry } = await setupTerminalMonitor()

    monitor.userInput("terminal-1", "printf '➜ hello\\n'; sleep 5\r")
    daemon.emitScreen("➜ hello\n")
    time.advance(2_000)
    expect(deliveries).toEqual([])

    daemon.emitScreen("➜ repo")
    time.advance(1_000)
    expect(deliveries).toEqual(["Terminal command finished"])

    monitor.dispose()
    registry.dispose()
  })

  test("does not submit a multiline shell buffer until it receives CR", async () => {
    const { time, daemon, deliveries, monitor, registry } = await setupTerminalMonitor()

    monitor.userInput("terminal-1", "echo first\nsecond")
    daemon.emitScreen("echo first\nsecond\n➜ repo")
    time.advance(2_000)
    expect(deliveries).toEqual([])

    monitor.userInput("terminal-1", "\r")
    daemon.emitScreen("command output\n➜ repo")
    time.advance(1_000)
    expect(deliveries).toEqual(["Terminal command finished"])

    monitor.dispose()
    registry.dispose()
  })
})
