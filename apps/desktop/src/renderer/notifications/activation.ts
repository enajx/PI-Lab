import { z } from "zod"

export const notificationActivationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent"),
    projectId: z.string().min(1),
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    agentId: z.string().min(1),
    label: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("workflow"),
    workflowId: z.string().min(1),
    runId: z.string().min(1),
  }),
  z.object({
    type: z.literal("terminal"),
    projectId: z.string().min(1),
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    label: z.string().min(1),
  }),
])

export type NotificationActivation = z.infer<typeof notificationActivationSchema>

export const projectNotificationSearchSchema = z.union([
  z.object({
    notificationId: z.string().min(1),
    notificationKind: z.literal("agent"),
    notificationSessionId: z.string().min(1),
    notificationWorkspaceId: z.string().min(1),
    notificationAgentId: z.string().min(1),
    notificationLabel: z.string().min(1).optional(),
  }),
  z.object({
    notificationId: z.string().min(1),
    notificationKind: z.literal("terminal"),
    notificationSessionId: z.string().min(1),
    notificationWorkspaceId: z.string().min(1),
    notificationAgentId: z.undefined().optional(),
    notificationLabel: z.string().min(1),
  }),
  z.object({
    notificationId: z.undefined().optional(),
    notificationKind: z.undefined().optional(),
    notificationSessionId: z.undefined().optional(),
    notificationWorkspaceId: z.undefined().optional(),
    notificationAgentId: z.undefined().optional(),
    notificationLabel: z.undefined().optional(),
  }),
])

export type ProjectNotificationSearch = z.infer<typeof projectNotificationSearchSchema>

export const workflowNotificationSearchSchema = z.union([
  z.object({
    notificationId: z.string().min(1),
    notificationWorkflowId: z.string().min(1),
    notificationRunId: z.string().min(1),
  }),
  z.object({
    notificationId: z.undefined().optional(),
    notificationWorkflowId: z.undefined().optional(),
    notificationRunId: z.undefined().optional(),
  }),
])

export type WorkflowNotificationSearch = z.infer<typeof workflowNotificationSearchSchema>
