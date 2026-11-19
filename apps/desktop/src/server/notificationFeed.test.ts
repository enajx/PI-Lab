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

function feed() {
  const dir = mkdtempSync(join(tmpdir(), "pi-lab-feed-"))
  dirs.push(dir)
  const activity = fakeActivity()
  const notifications = new NotificationFeed(dir, () => preferences, false)
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
  const { notifications } = feed()
  notifications.notify(finished)
  const late: NotificationStreamMessage[] = []
  notifications.subscribe((message) => late.push(message))
  expect(late).toEqual([])
  expect(notifications.history().map((event) => event.request.title)).toEqual(["Routine finished"])
})

test("a pending request alerts a client that connects later, until the agent stops waiting", () => {
  const { notifications, activity } = feed()
  activity.waiting(["s1"])
  notifications.notify(agentInput)
  const late: NotificationStreamMessage[] = []
  notifications.subscribe((message) => late.push(message))
  expect(late).toHaveLength(1)
  expect(late[0]).toMatchObject({ type: "alert", event: { kind: "request" } })

  // Answered from any device: the agent is no longer waiting, so every client clears it.
  activity.waiting([])
  expect(late[1]).toEqual({ type: "cleared", id: (late[0] as { event: { id: string } }).event.id })
  const later: NotificationStreamMessage[] = []
  notifications.subscribe((message) => later.push(message))
  expect(later).toEqual([])
  expect(notifications.history()).toEqual([])
})

test("muted or disabled events are not sent", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lab-feed-"))
  dirs.push(dir)
  const muted = new NotificationFeed(dir, () => ({ ...preferences, muted: true }), false)
  const seen: NotificationStreamMessage[] = []
  muted.subscribe((message) => seen.push(message))
  expect(muted.notify(finished)).toBe("muted")
  expect(seen).toEqual([])
})
