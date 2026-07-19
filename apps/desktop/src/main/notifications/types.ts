import { z } from "zod"

export const notificationSoundSchema = z.enum(["chime", "pulse", "success", "alert", "silent"])
export type NotificationSoundId = z.infer<typeof notificationSoundSchema>

export const notificationEventTypeSchema = z.enum([
  "agentInput",
  "agentTurnCompletion",
  "terminalCompletion",
  "workflowStart",
  "workflowCompletion",
  "workflowFailure",
])
export type NotificationEventType = z.infer<typeof notificationEventTypeSchema>

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

export const notificationSoundEventSchema = z.object({
  sound: notificationSoundSchema,
})
export type NotificationSoundEvent = z.infer<typeof notificationSoundEventSchema>

export const notificationDeliveryErrorSchema = z.object({
  message: z.string().min(1),
})
export type NotificationDeliveryError = z.infer<typeof notificationDeliveryErrorSchema>

export interface NotificationEventSetting {
  enabled: boolean
  sound: NotificationSoundId
}

export interface NotificationPreferences {
  muted: boolean
  agentInput: NotificationEventSetting
  agentTurnCompletion: NotificationEventSetting
  terminalCompletion: NotificationEventSetting
  workflowStart: NotificationEventSetting
  workflowCompletion: NotificationEventSetting
  workflowFailure: NotificationEventSetting
}

export interface NotificationRequest {
  eventType: NotificationEventType
  title: string
  body: string
  target: NotificationActivation
}
