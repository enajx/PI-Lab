import { describe, expect, test } from "vitest"
import { ActivityRegistry } from "./registry"
import {
  type ActivityClock,
  type ActivityRegistryChange,
  type ActivityScheduler,
  type ActivityTimer,
  IDLE_FALLBACK_MS,
  type RegisterAgentActivity,
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

const AGENT_SESSION: RegisterAgentActivity = {
  sessionId: "session-agent",
  projectId: "project-1",
  workspaceId: "workspace-1",
  agentId: "claude-code",
  workflowRunId: null,
  turnArmed: false,
}

const WORKFLOW_SESSION: RegisterAgentActivity = {
  sessionId: "session-workflow",
  projectId: "project-1",
  workspaceId: "workspace-2",
  agentId: "codex",
  workflowRunId: "run-1",
  turnArmed: true,
}

function setup(): {
  time: ManualTime
  registry: ActivityRegistry
  changes: ActivityRegistryChange[]
} {
  const time = new ManualTime()
  const registry = new ActivityRegistry({ clock: time, scheduler: time })
  const changes: ActivityRegistryChange[] = []
  registry.subscribe((change) => changes.push(change))
  return { time, registry, changes }
}

function activityPhases(changes: readonly ActivityRegistryChange[]): string[] {
  return changes.flatMap((change) => change.activityEvents.map((event) => event.phase))
}

describe("ActivityRegistry agent lifecycle", () => {
  test("does not claim the initial blank prompt as a completed turn", () => {
    const { registry, time } = setup()
    registry.register(AGENT_SESSION)

    registry.observeRenderedScreen(AGENT_SESSION.sessionId, "Claude Code\n\n❯ ")
    time.advance(WAITING_CONFIRMATION_MS)

    expect(registry.get(AGENT_SESSION.sessionId)).toMatchObject({
      state: "waiting",
      waitingReason: "initial-prompt",
      waitingEpisode: 1,
      turnArmed: false,
    })
    expect(registry.claimWaitingNotification(AGENT_SESSION.sessionId)).toBeNull()
  })

  test("confirms an armed turn prompt after two seconds and notifies once per waiting episode", () => {
    const { registry, time, changes } = setup()
    registry.register(AGENT_SESSION)
    registry.userSubmitted(AGENT_SESSION.sessionId)

    registry.observeRenderedScreen(AGENT_SESSION.sessionId, "Claude Code\n\n❯ ")
    time.advance(WAITING_CONFIRMATION_MS - 1)
    expect(registry.get(AGENT_SESSION.sessionId)?.state).toBe("working")

    time.advance(1)
    expect(registry.get(AGENT_SESSION.sessionId)).toMatchObject({
      state: "waiting",
      waitingReason: "turn-complete",
      waitingEpisode: 1,
    })
    expect(registry.claimWaitingNotification(AGENT_SESSION.sessionId)?.waitingEpisode).toBe(1)
    expect(registry.claimWaitingNotification(AGENT_SESSION.sessionId)).toBeNull()

    registry.userSubmitted(AGENT_SESSION.sessionId)
    expect(registry.get(AGENT_SESSION.sessionId)).toMatchObject({
      state: "working",
      waitingReason: null,
    })
    registry.observeRenderedScreen(AGENT_SESSION.sessionId, "Claude Code\n\n❯ ")
    time.advance(WAITING_CONFIRMATION_MS)
    expect(registry.get(AGENT_SESSION.sessionId)?.waitingEpisode).toBe(2)
    expect(registry.claimWaitingNotification(AGENT_SESSION.sessionId)?.waitingEpisode).toBe(2)
    expect(activityPhases(changes)).toEqual([
      "acquire",
      "working",
      "release",
      "idle",
      "acquire",
      "release",
      "idle",
    ])
  })

  test("requires permission and question screens to remain stable before waiting", () => {
    const { registry, time } = setup()
    registry.register(AGENT_SESSION)
    registry.userSubmitted(AGENT_SESSION.sessionId)

    registry.observeRenderedScreen(
      AGENT_SESSION.sessionId,
      "Do you want to proceed?\n❯ 1. Yes\n  2. No",
    )
    time.advance(1_000)
    registry.observeRenderedScreen(
      AGENT_SESSION.sessionId,
      "Question\nHow should Claude proceed?\n❯ 1. Carefully\n  2. Stop",
    )
    time.advance(1_001)
    expect(registry.get(AGENT_SESSION.sessionId)?.state).toBe("working")
    time.advance(999)
    expect(registry.get(AGENT_SESSION.sessionId)).toMatchObject({
      state: "waiting",
      waitingReason: "question",
    })
  })

  test("renewed qualifying output starts work and unchanged screen polling does not postpone idle", () => {
    const { registry, time } = setup()
    registry.register(AGENT_SESSION)
    registry.observeRenderedScreen(AGENT_SESSION.sessionId, "Claude Code\n\n❯ ")
    time.advance(WAITING_CONFIRMATION_MS)
    expect(registry.get(AGENT_SESSION.sessionId)?.state).toBe("waiting")

    registry.userSubmitted(AGENT_SESSION.sessionId)
    const output = "I found the failing test and am applying the fix now."
    registry.observeRenderedScreen(AGENT_SESSION.sessionId, output)
    expect(registry.get(AGENT_SESSION.sessionId)?.state).toBe("working")
    time.advance(IDLE_FALLBACK_MS - 1)
    registry.observeRenderedScreen(AGENT_SESSION.sessionId, output)
    time.advance(1)
    expect(registry.get(AGENT_SESSION.sessionId)).toMatchObject({
      state: "waiting",
      waitingReason: "idle",
      turnArmed: true,
    })
  })

  test("never applies the idle fallback without qualifying agent output", () => {
    const { registry, time } = setup()
    registry.register(AGENT_SESSION)
    registry.observeRenderedScreen(AGENT_SESSION.sessionId, "Thinking…")
    time.advance(IDLE_FALLBACK_MS * 2)
    expect(registry.get(AGENT_SESSION.sessionId)).toMatchObject({
      state: "working",
      lastQualifyingOutputAt: null,
    })
  })

  test("emits aggregate idle only after the last working session releases", () => {
    const { registry, time, changes } = setup()
    registry.register(AGENT_SESSION)
    registry.register({
      ...AGENT_SESSION,
      sessionId: "session-2",
      workspaceId: "workspace-2",
    })
    registry.processExited(AGENT_SESSION.sessionId, null)
    expect(activityPhases(changes)).toEqual(["acquire", "acquire", "release"])

    registry.observeRenderedScreen("session-2", "Codex\n\n› ")
    time.advance(WAITING_CONFIRMATION_MS)
    expect(activityPhases(changes)).toEqual(["acquire", "acquire", "release", "release", "idle"])
    expect(registry.snapshot()).toMatchObject({
      workingSessionIds: [],
      hasWorkingActivity: false,
    })
  })

  test("returns immutable copies rather than exposing registry state", () => {
    const { registry } = setup()
    const registered = registry.register(AGENT_SESSION)
    registered.state = "exited"
    const snapshotRecord = registry.snapshot().sessions[0]
    if (!snapshotRecord) throw new Error("Expected registered session")
    snapshotRecord.state = "waiting"
    expect(registry.get(AGENT_SESSION.sessionId)?.state).toBe("working")
  })

  test("restores a durable working record and preserves the original idle deadline", () => {
    const { registry, time } = setup()
    const restored = {
      ...registry.register(AGENT_SESSION),
      lastQualifyingOutputAt: time.now(),
    }
    registry.dispose()

    const recoveredChanges: ActivityRegistryChange[] = []
    const recovered = new ActivityRegistry({ clock: time, scheduler: time })
    recovered.subscribe((change) => recoveredChanges.push(change))
    time.advance(10_000)
    recovered.restore(restored)
    time.advance(IDLE_FALLBACK_MS - 10_001)
    expect(recovered.get(AGENT_SESSION.sessionId)?.state).toBe("working")
    time.advance(1)
    expect(recovered.get(AGENT_SESSION.sessionId)).toMatchObject({
      state: "waiting",
      waitingReason: "idle",
    })
    expect(activityPhases(recoveredChanges)).toEqual(["acquire", "release", "idle"])
  })
})

describe("ActivityRegistry interactive workflow lifecycle", () => {
  test("keeps permission waiting separate from completion, then completes at the normal prompt", () => {
    const { registry, time } = setup()
    expect(registry.register(WORKFLOW_SESSION).workflowState).toBe("pending")
    expect(registry.markWorkflowRunning(WORKFLOW_SESSION.sessionId)?.workflowState).toBe("running")

    registry.observeRenderedScreen(
      WORKFLOW_SESSION.sessionId,
      "Would you like to run this command?\n› 1. Yes, proceed\n  2. No",
    )
    time.advance(WAITING_CONFIRMATION_MS)
    expect(registry.get(WORKFLOW_SESSION.sessionId)).toMatchObject({
      state: "waiting",
      waitingReason: "permission",
      workflowState: "running",
      workflowCompletedAt: null,
    })

    registry.userSubmitted(WORKFLOW_SESSION.sessionId)
    registry.observeRenderedScreen(
      WORKFLOW_SESSION.sessionId,
      "Applied the requested changes and verified the tests.",
    )
    registry.observeRenderedScreen(WORKFLOW_SESSION.sessionId, "OpenAI Codex\n\n› ")
    time.advance(WAITING_CONFIRMATION_MS)
    const completed = registry.get(WORKFLOW_SESSION.sessionId)
    expect(completed).toMatchObject({
      state: "waiting",
      waitingReason: "turn-complete",
      workflowState: "completed",
    })
    expect(completed?.workflowCompletedAt).toBe(time.now())
  })

  test("later prompts and process exit cannot rewrite a completed workflow run", () => {
    const { registry, time } = setup()
    registry.register(WORKFLOW_SESSION)
    registry.markWorkflowRunning(WORKFLOW_SESSION.sessionId)
    registry.observeRenderedScreen(WORKFLOW_SESSION.sessionId, "OpenAI Codex\n\n› ")
    time.advance(WAITING_CONFIRMATION_MS)
    const completedAt = registry.get(WORKFLOW_SESSION.sessionId)?.workflowCompletedAt

    registry.userSubmitted(WORKFLOW_SESSION.sessionId)
    registry.observeRenderedScreen(WORKFLOW_SESSION.sessionId, "Fatal error: later ad-hoc turn")
    registry.processExited(WORKFLOW_SESSION.sessionId, "exit code 1")
    expect(registry.get(WORKFLOW_SESSION.sessionId)).toMatchObject({
      state: "exited",
      workflowState: "completed",
      workflowCompletedAt: completedAt,
      workflowFailureReason: null,
    })
  })

  test.each([
    [
      "process exit",
      (registry: ActivityRegistry) => registry.processExited("session-workflow", "exit 1"),
    ],
    [
      "fatal screen",
      (registry: ActivityRegistry) =>
        registry.observeRenderedScreen("session-workflow", "Fatal error: provider unavailable"),
    ],
    [
      "launch failure",
      (registry: ActivityRegistry) => registry.failLaunch("session-workflow", "command not found"),
    ],
  ])("marks an unfinished workflow failed on %s", (_name, fail) => {
    const { registry } = setup()
    registry.register(WORKFLOW_SESSION)
    fail(registry)
    expect(registry.get(WORKFLOW_SESSION.sessionId)).toMatchObject({
      state: "exited",
      workflowState: "failed",
    })
  })
})
