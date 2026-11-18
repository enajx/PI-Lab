import { join } from "node:path"
import { app } from "electron"
import { autoUpdater } from "electron-updater"
import type { ServerClient } from "../server/client"
import { setReadyUpdateMenuItem } from "../window/appMenu"
import type { ShutdownGuard } from "../window/shutdownGuard"
import type { DataCompatibility } from "./compatibility"
import { PublicUpdateController, type UpdateStatus } from "./controller"
import { ElectronUpdateEngine } from "./electronEngine"
import { connectUpdateFeedback, publishUpdateMessage, publishUpdateStatus } from "./feedback"
import { recordInstalledVersion } from "./installedVersion"
import { startServerUpdates } from "./serverUpdates"

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/**
 * Start public macOS update checks once the app is connected to its server,
 * which supplies the data format and the selected channel.
 */
export async function startPublicUpdates(
  server: ServerClient,
  shutdownGuard: ShutdownGuard,
  onStatus: (status: UpdateStatus, restart: () => void) => void,
): Promise<void> {
  autoUpdater.logger = console
  const createController = (compatibility: DataCompatibility): PublicUpdateController => {
    const controller: PublicUpdateController = new PublicUpdateController(
      new ElectronUpdateEngine(autoUpdater),
      compatibility,
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
    return controller
  }
  if (
    recordInstalledVersion(
      join(app.getPath("userData"), "last-installed-version"),
      app.getVersion(),
    )
  ) {
    publishUpdateMessage(`Updated to PI Lab ${app.getVersion()}`, false)
  }
  const updates = await startServerUpdates(server, createController, () =>
    shutdownGuard.cancelUpdateInstall(),
  )
  const interval = setInterval(() => {
    void updates.controller.checkAgain()
  }, CHECK_INTERVAL_MS)
  app.once("will-quit", () => {
    clearInterval(interval)
    updates.stop()
  })
}
