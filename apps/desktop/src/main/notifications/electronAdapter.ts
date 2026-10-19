import { app, BrowserWindow, Notification } from "electron"
import { createAppFocusAdapter } from "./focusAdapter"
import { createNativeNotificationAdapter } from "./nativeAdapter"
import type { AppFocusAdapter, NativeNotificationAdapter } from "./service"

export function createElectronNativeNotificationAdapter(
  getIconPath: () => string | null,
): NativeNotificationAdapter {
  return createNativeNotificationAdapter(getIconPath, {
    platform: process.platform,
    isSupported: () => Notification.isSupported(),
    create: (input) => new Notification(input),
  })
}

export function createElectronAppFocusAdapter(createWindow: () => BrowserWindow): AppFocusAdapter {
  return createAppFocusAdapter({
    hasFocusedWindow: () => BrowserWindow.getFocusedWindow() !== null,
    getWindows: () => BrowserWindow.getAllWindows(),
    createWindow,
    focusApp: () => app.focus({ steal: true }),
  })
}
