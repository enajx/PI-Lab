import type { z } from "zod"
import type {
  notificationActivationSchema,
  notificationDeliveryErrorSchema,
  notificationEventTypeSchema,
  notificationSoundEventSchema,
  notificationSoundSchema,
} from "../../shared/clientApi"

// The wire schemas live with the rest of the client API (shared/clientApi.ts).
export {
  notificationActivationSchema,
  notificationDeliveryErrorSchema,
  notificationEventTypeSchema,
  notificationSoundEventSchema,
  notificationSoundSchema,
} from "../../shared/clientApi"

export type NotificationSoundId = z.infer<typeof notificationSoundSchema>
export type NotificationEventType = z.infer<typeof notificationEventTypeSchema>
export type NotificationActivation = z.infer<typeof notificationActivationSchema>
export type NotificationSoundEvent = z.infer<typeof notificationSoundEventSchema>
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
