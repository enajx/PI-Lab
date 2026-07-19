import { useNavigate } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { useTRPCClient } from "../trpc/react"
import { notificationActivationSchema } from "./activation"
import { NOTIFICATION_SOUND_IDS, type NotificationSoundId, playNotificationSound } from "./sounds"

function isSoundId(value: unknown): value is NotificationSoundId {
  return typeof value === "string" && NOTIFICATION_SOUND_IDS.includes(value as NotificationSoundId)
}

/**
 * App-lifetime renderer endpoint for notification clicks and custom sounds.
 * Native banners stay silent; this bridge owns sound playback so every platform
 * uses the same bundled sound and focus suppression.
 */
export function NotificationBridge() {
  const client = useTRPCClient()
  const navigate = useNavigate()
  const [deliveryError, setDeliveryError] = useState<string | null>(null)
  const activationSequence = useRef(0)

  useEffect(() => {
    const activation = client.notifications.onActivation.subscribe(undefined, {
      onData: (raw) => {
        const parsed = notificationActivationSchema.safeParse(raw)
        if (!parsed.success) {
          console.error("Ignored invalid notification activation", parsed.error)
          return
        }
        const target = parsed.data
        activationSequence.current += 1
        const notificationId = `${target.type}-${activationSequence.current}`
        if (target.type === "agent") {
          void navigate({
            to: "/projects/$projectId",
            params: { projectId: target.projectId },
            search: {
              notificationId,
              notificationKind: "agent",
              notificationSessionId: target.sessionId,
              notificationWorkspaceId: target.workspaceId,
              notificationAgentId: target.agentId,
              notificationLabel: target.label,
            },
          })
          return
        }
        if (target.type === "terminal") {
          void navigate({
            to: "/projects/$projectId",
            params: { projectId: target.projectId },
            search: {
              notificationId,
              notificationKind: "terminal",
              notificationSessionId: target.sessionId,
              notificationWorkspaceId: target.workspaceId,
              notificationLabel: target.label,
            },
          })
          return
        }
        void navigate({
          to: "/automations",
          search: {
            notificationId,
            notificationWorkflowId: target.workflowId,
            notificationRunId: target.runId,
          },
        })
      },
      onError: (error) => console.error("Notification activation subscription failed", error),
    })
    const sound = client.notifications.onSound.subscribe(undefined, {
      onData: (event) => {
        if (!isSoundId(event.sound)) {
          console.error("Ignored invalid notification sound", event)
          return
        }
        void playNotificationSound(event.sound, { suppressed: document.hasFocus() }).then(
          (result) => {
            if (result.status === "failed") {
              console.error("Notification sound delivery failed", result.error)
            }
          },
        )
      },
      onError: (error) => console.error("Notification sound subscription failed", error),
    })
    const deliveryErrors = client.notifications.onDeliveryError.subscribe(undefined, {
      onData: (raw) => {
        const parsed = z.object({ message: z.string().min(1) }).safeParse(raw)
        if (!parsed.success) {
          console.error("Ignored invalid notification delivery error", parsed.error)
          return
        }
        console.warn("Native notification delivery failed", parsed.data.message)
        setDeliveryError(parsed.data.message)
      },
      onError: (error) => console.error("Notification error subscription failed", error),
    })

    return () => {
      activation.unsubscribe()
      sound.unsubscribe()
      deliveryErrors.unsubscribe()
    }
  }, [client, navigate])

  if (!deliveryError) return null
  return (
    <div
      role="alert"
      data-testid="notification-delivery-error"
      className="fixed right-4 bottom-4 z-50 flex max-w-sm items-center gap-3 rounded-md border border-destructive/40 bg-background px-3 py-2 text-destructive text-sm shadow-lg"
    >
      <span>Native notification unavailable: {deliveryError}</span>
      <button
        type="button"
        aria-label="Dismiss notification delivery error"
        className="rounded px-1 text-muted-foreground hover:text-foreground"
        onClick={() => setDeliveryError(null)}
      >
        Dismiss
      </button>
    </div>
  )
}
