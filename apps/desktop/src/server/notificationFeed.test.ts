import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import type { ActivityRegistrySource } from "../main/caffeine/types"
import type { NotificationPreferences, NotificationRequest } from "../main/notifications"
import { NotificationFeed, type NotificationStreamMessage } from "./notificationFeed"

const enabled = { enabled: true, sound: "chime" as const }
const preferences: NotificationPreferences = {
  muted: false,
  agentInput: enabled,
  agentTurnCompletion: enabled,
  terminalCompletion: enabled,
  workflowStart: enabled,
  workflowCompletion: enabled,
  workflowFailure: enabled,
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake activity registry (labelled: no real terminals) that tests drive by hand. */
function fakeActivity() {
  let listener: Parameters<ActivityRegistrySource["subscribe"]>[0] = () => undefined
  const source: ActivityRegistrySource = {
    snapshot: () => ({ sessions: [], workingSessionIds: [], hasWorkingActivity: false }),
    subscribe: (next) => {
      listener = next
      return () => undefined
    },
  }
  return {
    source,
    waiting(sessionIds: string[]) {
      listener({
        snapshot: {
          sessions: sessionIds.map((sessionId) => ({ sessionId, state: "waiting" })) as never,
          workingSessionIds: [],
          hasWorkingActivity: false,
        },
        activityEvents: [],
      })
    },
  }
}

function feed(current: NotificationPreferences) {
  const dir = mkdtempSync(join(tmpdir(), "pi-lab-feed-"))
  dirs.push(dir)
  const activity = fakeActivity()
  const notifications = new NotificationFeed(dir, () => current, false)
  notifications.watch(activity.source)
  return { notifications, activity }
}

const agentInput: NotificationRequest = {
  eventType: "agentInput",
  title: "Agent needs input",
  body: "Proceed?",
  target: {
    type: "agent",
    projectId: "p",
    workspaceId: "w",
    sessionId: "s1",
    agentId: "a",
    origin: "project",
  },
}
const finished: NotificationRequest = {
  eventType: "workflowCompletion",
  title: "Routine finished",
  body: "Nightly",
  target: { type: "workflow", workflowId: "r", runId: "1" },
}

test("information events go to the history and are not re-sent to a client that connects later", () => {
  const { notifications } = feed(preferences)
  notifications.notify(finished)
  const late: NotificationStreamMessage[] = []
  notifications.subscribe((message) => late.push(message))
  expect(late).toEqual([])
  expect(notifications.history().map((event) => event.request.title)).toEqual(["Routine finished"])
})

test("a pending request alerts a client that connects later, until the agent stops waiting", () => {
  const { notifications, activity } = feed(preferences)
  activity.waiting(["s1"])
  notifications.notify(agentInput)
  const late: NotificationStreamMessage[] = []
  notifications.subscribe((message) => late.push(message))
  expect(late).toHaveLength(1)
  expect(late[0]).toMatchObject({ type: "alert", banner: true, event: { kind: "request" } })

  // Answered from any device: the agent is no longer waiting, so every client clears it.
  activity.waiting([])
  expect(late[1]).toEqual({ type: "cleared", id: (late[0] as { event: { id: string } }).event.id })
  const later: NotificationStreamMessage[] = []
  notifications.subscribe((message) => later.push(message))
  expect(later).toEqual([])
  expect(notifications.history()).toEqual([])
})

test("with alerts muted or the event off, a waiting agent is still pending and sent with no banner", () => {
  for (const current of [
    { ...preferences, muted: true },
    { ...preferences, agentInput: { enabled: false, sound: "chime" as const } },
  ]) {
    const { notifications, activity } = feed(current)
    activity.waiting(["s1"])
    const early: NotificationStreamMessage[] = []
    notifications.subscribe((message) => early.push(message))
    notifications.notify(agentInput)
    expect(early).toEqual([
      { type: "alert", banner: false, event: expect.objectContaining({ kind: "request" }) },
    ])
    const id = (early[0] as { event: { id: string } }).event.id
    expect(notifications.pending(id)?.request.title).toBe("Agent needs input")

    // A client that connects later (the phone) gets it too, still with no banner.
    const late: NotificationStreamMessage[] = []
    notifications.subscribe((message) => late.push(message))
    expect(late).toEqual([
      { type: "alert", banner: false, event: early[0]?.type === "alert" ? early[0].event : null },
    ])

    // Answered from one device: it clears for every client.
    expect(notifications.take(id)?.id).toBe(id)
    expect(early[1]).toEqual({ type: "cleared", id })
    expect(late[1]).toEqual({ type: "cleared", id })
    expect(notifications.pending(id)).toBeNull()
  }
})

test("muted, disabled or suppressed information events are still sent and kept, with no banner", () => {
  const off = { enabled: false, sound: "chime" as const }
  for (const [current, suppress] of [
    [{ ...preferences, muted: true }, false],
    [{ ...preferences, workflowCompletion: off }, false],
    [preferences, true],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), "pi-lab-feed-"))
    dirs.push(dir)
    const notifications = new NotificationFeed(dir, () => current, suppress)
    const seen: NotificationStreamMessage[] = []
    notifications.subscribe((message) => seen.push(message))
    notifications.notify(finished)
    expect(seen).toEqual([
      { type: "alert", banner: false, event: expect.objectContaining({ kind: "info" }) },
    ])
    expect(notifications.history().map((event) => event.request.title)).toEqual([
      "Routine finished",
    ])
  }
})
