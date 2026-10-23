import { BrowserWindow } from "electron"
import { UPDATE_CHANGED_CHANNEL, type UpdateSnapshot } from "../../shared/updates"
import type { PublicUpdateController, UpdateStatus } from "./controller"

let snapshot: UpdateSnapshot = { available: false, checking: false, message: null, revision: 0 }
let controller: PublicUpdateController | null = null
let manual = false
let noticeUntil = 0

/** Current state also reaches renderers that mounted after an update event. */
export function updateSnapshot(): UpdateSnapshot {
  return Date.now() < noticeUntil ? snapshot : { ...snapshot, message: null }
}

/** Publish short update feedback to every app window. */
export function publishUpdateMessage(message: string | null, checking: boolean): void {
  noticeUntil = Date.now() + 3000
  snapshot = { ...snapshot, message, checking, revision: snapshot.revision + 1 }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(UPDATE_CHANGED_CHANNEL, snapshot)
  }
}

/** Expose the initialized controller to explicit Settings and palette checks. */
export function connectUpdateFeedback(value: PublicUpdateController): void {
  controller = value
  snapshot = { ...snapshot, available: true }
}

/** Automatic checks stay quiet unless an update is ready; explicit checks report outcomes. */
export function publishUpdateStatus(status: UpdateStatus): void {
  if (status.kind === "ready") {
    manual = false
    publishUpdateMessage(`PI Lab ${status.version} is ready to install on restart.`, false)
  } else if (manual) {
    const message =
      status.kind === "checking"
        ? "Checking for updates…"
        : status.kind === "idle"
          ? "PI Lab is up to date."
          : status.kind === "error"
            ? `Could not check for updates: ${status.message}`
            : status.kind === "restart-required"
              ? "Restart PI Lab to use the selected update channel."
              : `Waiting for a compatible update: ${status.reason}`
    publishUpdateMessage(message, status.kind === "checking")
    if (status.kind !== "checking") manual = false
  } else {
    snapshot = { ...snapshot, checking: status.kind === "checking" }
  }
}

/** Reuse an ongoing check and never replace a downloaded update. */
export async function checkForUpdates(): Promise<void> {
  if (!controller) {
    publishUpdateMessage(
      "Updates are available in public macOS releases. This build does not auto-update.",
      false,
    )
    return
  }
  manual = true
  const current = controller.current()
  if (
    current.kind === "ready" ||
    current.kind === "restart-required" ||
    current.kind === "checking"
  ) {
    publishUpdateStatus(current)
    return
  }
  await controller.checkAgain()
}
