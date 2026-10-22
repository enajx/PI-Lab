import type { EventBroker } from "./broker"
import type {
  NotificationActivation,
  NotificationDeliveryError,
  NotificationPreferences,
  NotificationRequest,
  NotificationSoundEvent,
} from "./types"

export interface NativeNotificationInput {
  title: string
  body: string
  silent: true
}

export interface NativeNotificationHandlers {
  onClick: () => void
  onFailure: (message: string) => void
}

export interface NativeNotificationAdapter {
  isSupported: () => boolean
  deliver: (input: NativeNotificationInput, handlers: NativeNotificationHandlers) => void
}

export interface AppFocusAdapter {
  isFocused: () => boolean
  restoreAndFocus: () => void
}

export interface NotificationLogger {
  warn: (message: string) => void
}

export interface NotificationServiceOptions {
  /** Automated runtimes suppress desktop output without changing user preferences. */
  suppressDelivery?: boolean
  native: NativeNotificationAdapter
  focus: AppFocusAdapter
  getPreferences: () => NotificationPreferences
  activations: EventBroker<NotificationActivation>
  sounds: EventBroker<NotificationSoundEvent>
  errors: EventBroker<NotificationDeliveryError>
  logger: NotificationLogger
}

export type NotificationOutcome = "delivered" | "focused" | "muted" | "disabled"

/**
 * Main-process notification policy. Native banners are deliberately silent;
 * renderer sound playback gives every platform the selected bundled sound.
 */
export class NotificationService {
  constructor(private readonly options: NotificationServiceOptions) {}

  notify(request: NotificationRequest): NotificationOutcome {
    const preferences = this.options.getPreferences()
    if (this.options.suppressDelivery || preferences.muted) return "muted"
    const eventSetting = preferences[request.eventType]
    if (!eventSetting.enabled) return "disabled"
    if (this.options.focus.isFocused()) return "focused"

    this.options.sounds.publish({ sound: eventSetting.sound })
    if (!this.options.native.isSupported()) {
      this.reportFailure("Native notifications are not supported on this system")
      return "delivered"
    }

    const onFailure = (message: string): void => {
      this.reportFailure(message)
    }
    const onClick = (): void => {
      this.options.focus.restoreAndFocus()
      this.options.activations.publish(request.target)
    }

    try {
      this.options.native.deliver(
        { title: request.title, body: request.body, silent: true },
        { onClick, onFailure },
      )
    } catch (error) {
      onFailure(error instanceof Error ? error.message : String(error))
    }
    return "delivered"
  }

  private reportFailure(message: string): void {
    const surfaced = `Native notification delivery failed: ${message}`
    this.options.logger.warn(surfaced)
    this.options.errors.publish({ message: surfaced })
  }
}
