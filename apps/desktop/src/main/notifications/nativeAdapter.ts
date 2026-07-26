import type {
  NativeNotificationAdapter,
  NativeNotificationHandlers,
  NativeNotificationInput,
} from "./service"

export interface PlatformNotification {
  once(event: "click", listener: () => void): void
  once(event: "close", listener: () => void): void
  once(event: "failed", listener: (event: unknown, error: string) => void): void
  show: () => void
}

export interface PlatformNotificationInput extends NativeNotificationInput {
  icon?: string
}

export interface PlatformNotificationDependencies {
  platform: NodeJS.Platform
  isSupported: () => boolean
  create: (input: PlatformNotificationInput) => PlatformNotification
  /** Injectable ownership seam; production uses an adapter-lifetime set. */
  retainedNotifications?: Set<PlatformNotification>
}

/**
 * Construct the Electron-facing adapter behind injectable platform seams. The
 * native banner stays silent. macOS owns sender identity through the application
 * bundle; passing Electron's `icon` option there would add a second content
 * image. Other platforms receive the explicit Pi tile.
 */
export function createNativeNotificationAdapter(
  iconPath: string | null,
  dependencies: PlatformNotificationDependencies,
): NativeNotificationAdapter {
  const retainedNotifications =
    dependencies.retainedNotifications ?? new Set<PlatformNotification>()
  return {
    isSupported: dependencies.isSupported,
    deliver: (input: NativeNotificationInput, handlers: NativeNotificationHandlers): void => {
      const notification = dependencies.create({
        ...input,
        ...(iconPath && dependencies.platform !== "darwin" ? { icon: iconPath } : {}),
      })
      // Electron's Notification is a native EventEmitter whose JavaScript
      // wrapper must remain reachable until delivery finishes. A local-only
      // instance can be collected before macOS emits show/click/failure events.
      retainedNotifications.add(notification)
      const release = (): void => {
        retainedNotifications.delete(notification)
      }
      notification.once("click", () => {
        release()
        handlers.onClick()
      })
      notification.once("close", release)
      notification.once("failed", (_event, error) => {
        release()
        handlers.onFailure(error)
      })
      notification.show()
    },
  }
}
