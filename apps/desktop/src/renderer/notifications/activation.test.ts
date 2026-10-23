import { describe, expect, test } from "vitest"
import {
  notificationActivationSchema,
  projectNotificationSearchSchema,
  workflowNotificationSearchSchema,
} from "./activation"

describe("notification activation contracts", () => {
  test("accepts an exact durable agent-session target", () => {
    expect(
      notificationActivationSchema.parse({
        type: "agent",
        projectId: "project-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        agentId: "codex",
      }),
    ).toMatchObject({ sessionId: "session-1", projectId: "project-1" })
  })

  test("rejects an agent click that cannot identify a live session", () => {
    expect(
      notificationActivationSchema.safeParse({
        type: "agent",
        projectId: "project-1",
        workspaceId: "workspace-1",
        agentId: "codex",
      }).success,
    ).toBe(false)
  })

  test("accepts exact project and routine search targets and rejects empty ids", () => {
    expect(
      projectNotificationSearchSchema.parse({
        notificationId: "notification-1",
        notificationKind: "agent",
        notificationSessionId: "session-1",
        notificationWorkspaceId: "workspace-1",
        notificationAgentId: "codex",
      }),
    ).toMatchObject({ notificationSessionId: "session-1" })
    expect(
      projectNotificationSearchSchema.parse({
        notificationId: "notification-terminal",
        notificationKind: "terminal",
        notificationSessionId: "terminal-1",
        notificationWorkspaceId: "workspace-1",
        notificationLabel: "Terminal",
      }),
    ).toMatchObject({ notificationKind: "terminal", notificationSessionId: "terminal-1" })
    expect(
      workflowNotificationSearchSchema.parse({
        notificationId: "notification-2",
        notificationWorkflowId: "workflow-1",
        notificationRunId: "run-1",
      }),
    ).toMatchObject({ notificationRunId: "run-1" })
    expect(workflowNotificationSearchSchema.safeParse({ notificationRunId: "" }).success).toBe(
      false,
    )
    expect(
      projectNotificationSearchSchema.safeParse({
        notificationId: "notification-3",
        notificationSessionId: "session-3",
      }).success,
    ).toBe(false)
  })
})
