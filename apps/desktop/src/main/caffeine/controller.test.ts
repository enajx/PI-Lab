import { describe, expect, test } from "vitest"
import {
  type ActivityClock,
  ActivityRegistry,
  type ActivityScheduler,
  type ActivityTimer,
} from "../activity"
import { CaffeineController } from "./controller"
import {
  CAFFEINE_AUDIT_MS,
  CAFFEINE_GRACE_MS,
  type CaffeineSettings,
  type PowerBlockerKind,
  type PowerSaveBlockerAdapter,
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

class FakePower implements PowerSaveBlockerAdapter {
  private nextId = 1
  readonly starts: Array<{ id: number; kind: PowerBlockerKind }> = []
  readonly stops: number[] = []
  readonly live = new Set<number>()

  start(kind: PowerBlockerKind): number {
    const id = this.nextId++
    this.starts.push({ id, kind })
    this.live.add(id)
    return id
  }

  stop(id: number): void {
    this.stops.push(id)
    this.live.delete(id)
  }

  isStarted(id: number): boolean {
    return this.live.has(id)
  }
}

const OFF: CaffeineSettings = { mode: "off", scope: "system-only" }
const AUTO: CaffeineSettings = { mode: "auto", scope: "system-only" }

function setup(initialSettings?: CaffeineSettings): {
  time: ManualTime
  power: FakePower
  registry: ActivityRegistry
  controller: CaffeineController
} {
  const time = new ManualTime()
  const power = new FakePower()
  const registry = new ActivityRegistry({ clock: time, scheduler: time })
  const controller = new CaffeineController({
    power,
    clock: time,
    scheduler: time,
    activity: registry,
    initialSettings: initialSettings ?? OFF,
  })
  return { time, power, registry, controller }
}

function registerAgent(
  registry: ActivityRegistry,
  sessionId: string,
  workflowRunId: string | null,
): void {
  registry.register({
    sessionId,
    projectId: "project-1",
    workspaceId: "workspace-1",
    agentId: "codex",
    workflowRunId,
    turnArmed: workflowRunId !== null,
  })
}

function finishTurn(registry: ActivityRegistry, time: ManualTime, sessionId: string): void {
  registry.observeRenderedScreen(sessionId, "Codex\n\n› ")
  time.advance(2_000)
}

describe("CaffeineController", () => {
  test("Off never acquires for agent, terminal, or tagged operation activity", () => {
    const { controller, power, registry } = setup()
    registerAgent(registry, "session-off", null)
    controller.markTerminalActivity()
    const finish = controller.beginMeaningfulActivity("cluster:refresh-all")

    expect(controller.status()).toEqual({
      mode: "off",
      scope: "system-only",
      held: false,
    })
    expect(power.starts).toEqual([])
    finish()
  })

  test("maps On scopes to Electron blocker kinds and restarts a held blocker on scope change", () => {
    const { controller, power } = setup()

    expect(controller.configure({ mode: "on", scope: "system-only" })).toEqual({
      mode: "on",
      scope: "system-only",
      held: true,
    })
    expect(power.starts).toEqual([{ id: 1, kind: "prevent-app-suspension" }])

    controller.configure({ mode: "on", scope: "system-plus-display" })
    expect(power.stops).toEqual([1])
    expect(power.starts[1]).toEqual({ id: 2, kind: "prevent-display-sleep" })

    controller.configure({ mode: "off", scope: "system-plus-display" })
    expect(controller.status().held).toBe(false)
    expect(power.stops).toEqual([1, 2])
  })

  test.each([
    { workflowRunId: null, label: "agent" },
    { workflowRunId: "run-1", label: "interactive workflow" },
  ])("Auto acquires immediately for a working $label and releases after 15 idle minutes", ({
    workflowRunId,
  }) => {
    const { controller, registry, time } = setup(AUTO)
    expect(controller.status().held).toBe(false)

    registerAgent(registry, "session-1", workflowRunId)
    expect(controller.status().held).toBe(true)

    finishTurn(registry, time, "session-1")
    time.advance(CAFFEINE_GRACE_MS - 1)
    expect(controller.status().held).toBe(true)
    time.advance(1)
    expect(controller.status().held).toBe(false)
  })

  test("Auto waits until every tracked turn is idle before starting the grace period", () => {
    const { controller, registry, time } = setup(AUTO)
    registerAgent(registry, "session-1", null)
    registerAgent(registry, "session-2", "run-2")

    finishTurn(registry, time, "session-1")
    time.advance(CAFFEINE_GRACE_MS)
    expect(controller.status().held).toBe(true)

    finishTurn(registry, time, "session-2")
    time.advance(CAFFEINE_GRACE_MS)
    expect(controller.status().held).toBe(false)
  })

  test("plain terminal input or output acquires Auto and rearms its grace deadline", () => {
    const { controller, time } = setup(AUTO)

    controller.markTerminalActivity()
    expect(controller.status().held).toBe(true)
    time.advance(CAFFEINE_GRACE_MS - 1_000)
    controller.markTerminalActivity()
    time.advance(1_001)
    expect(controller.status().held).toBe(true)
    time.advance(CAFFEINE_GRACE_MS - 1_001)
    expect(controller.status().held).toBe(false)
  })

  test("tagged meaningful work holds Auto for its duration and then receives the idle grace", () => {
    const { controller, time } = setup(AUTO)
    const finishFirst = controller.beginMeaningfulActivity("zotero:attach")
    const finishSecond = controller.beginMeaningfulActivity("zotero:attach")

    time.advance(CAFFEINE_GRACE_MS * 2)
    expect(controller.status().held).toBe(true)
    finishFirst()
    time.advance(CAFFEINE_GRACE_MS)
    expect(controller.status().held).toBe(true)
    finishSecond()
    time.advance(CAFFEINE_GRACE_MS)
    expect(controller.status().held).toBe(false)
  })

  test("the safety audit restores a blocker lost outside the controller", () => {
    const { controller, power, time } = setup({ mode: "on", scope: "system-only" })
    power.live.delete(1)

    time.advance(CAFFEINE_AUDIT_MS)
    expect(controller.status().held).toBe(true)
    expect(power.starts).toHaveLength(2)
  })

  test("startup re-evaluates restored working activity and shutdown always releases", () => {
    const time = new ManualTime()
    const power = new FakePower()
    const registry = new ActivityRegistry({ clock: time, scheduler: time })
    registerAgent(registry, "restored-session", null)

    const controller = new CaffeineController({
      power,
      clock: time,
      scheduler: time,
      activity: registry,
      initialSettings: AUTO,
    })
    expect(controller.status().held).toBe(true)

    controller.dispose()
    expect(controller.status().held).toBe(false)
    expect(power.stops).toEqual([1])
    time.advance(CAFFEINE_AUDIT_MS * 2)
    expect(power.starts).toHaveLength(1)
  })
})
