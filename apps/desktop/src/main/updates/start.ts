import { join } from "node:path"
import { getSettingsOrDefaults } from "@pi-lab/local-db"
import { app } from "electron"
import { autoUpdater } from "electron-updater"
import { getDb, getDbStatus } from "../db/db"
import { setReadyUpdateMenuItem } from "../window/appMenu"
import type { ShutdownGuard } from "../window/shutdownGuard"
import { PublicUpdateController, type UpdateStatus } from "./controller"
import { ElectronUpdateEngine } from "./electronEngine"
import { connectUpdateFeedback, publishUpdateMessage, publishUpdateStatus } from "./feedback"
import { recordInstalledVersion } from "./installedVersion"
import { onPublicUpdateChannelChanged } from "./selection"

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** Start public macOS update checks only after the full runtime has opened the DB. */
export async function startPublicUpdates(
  shutdownGuard: ShutdownGuard,
  onStatus: (status: UpdateStatus, restart: () => void) => void,
): Promise<void> {
  autoUpdater.logger = console
  const controller = new PublicUpdateController(
    new ElectronUpdateEngine(autoUpdater),
    getDbStatus().compatibility,
    (status) => {
      if (status.kind === "error") shutdownGuard.cancelUpdateInstall()
      if (status.kind === "waiting-for-compatible-release") {
        console.info(
          `[pi-lab] Skipping incompatible update ${status.version}; waiting for a later release: ${status.reason}`,
        )
      }
      setReadyUpdateMenuItem(
        status.kind === "ready"
          ? { version: status.version, restart: () => controller.restartToUpdate() }
          : null,
      )
      publishUpdateStatus(status)
      onStatus(status, () => controller.restartToUpdate())
    },
    (install) => shutdownGuard.requestUpdateInstall(install),
    (install) => shutdownGuard.setInstallOnApprovedQuit(install),
  )
  connectUpdateFeedback(controller)
  if (
    recordInstalledVersion(
      join(app.getPath("userData"), "last-installed-version"),
      app.getVersion(),
    )
  ) {
    publishUpdateMessage(`Updated to PI Lab ${app.getVersion()}`, false)
  }
  const unsubscribe = onPublicUpdateChannelChanged((channel) => {
    shutdownGuard.cancelUpdateInstall()
    controller.selectedChannelChanged(channel)
  })
  const interval = setInterval(() => {
    void controller.checkAgain()
  }, CHECK_INTERVAL_MS)
  app.once("will-quit", () => {
    clearInterval(interval)
    unsubscribe()
  })
  await controller.start(getSettingsOrDefaults(getDb()).publicUpdateChannel)
}
