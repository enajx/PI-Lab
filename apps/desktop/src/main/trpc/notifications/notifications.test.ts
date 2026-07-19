import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { NotificationActivation } from "../../notifications"
import { createHarness, type Harness } from "../testHarness"

let harness: Harness

beforeEach(async () => {
  harness = await createHarness()
})

afterEach(async () => {
  await harness.dispose()
})

describe("notification subscription contract", () => {
  test("delivers a validated exact activation target through the public router", async () => {
    const received: NotificationActivation[] = []
    const stream = await harness.caller.notifications.onActivation()
    const subscription = stream.subscribe({ next: (event) => received.push(event) })
    const target: NotificationActivation = {
      type: "agent",
      projectId: "project-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      agentId: "codex",
    }

    harness.notifications.activations.publish(target)

    expect(received).toEqual([target])
    subscription.unsubscribe()
  })

  test("rejects malformed activation targets at the subscription boundary", async () => {
    const stream = await harness.caller.notifications.onActivation()
    const subscription = stream.subscribe({ next: () => {} })

    expect(() =>
      harness.notifications.activations.publish({
        type: "agent",
        projectId: "project-1",
        workspaceId: "",
        sessionId: "session-1",
        agentId: "codex",
      }),
    ).toThrow()
    subscription.unsubscribe()
  })
})
