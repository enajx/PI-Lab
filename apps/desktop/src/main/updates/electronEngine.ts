import type { AppUpdater } from "electron-updater"
import type { UpdateEngine } from "./controller"
import { type PublicUpdateChannel, updaterFeedChannel } from "./release"

/** Adapter for electron-updater; it is created only after the editor is ready. */
export class ElectronUpdateEngine implements UpdateEngine {
  constructor(private readonly updater: AppUpdater) {}

  configure(channel: PublicUpdateChannel): void {
    this.updater.autoDownload = true
    // Keep the ZIP downloaded but unstaged in Squirrel.Mac. The approved Quit
    // path installs it, so changing channels can leave an old ZIP unused.
    this.updater.autoInstallOnAppQuit = false
    this.updater.channel = updaterFeedChannel(channel)
    // The channel setter enables downgrades. A Stable switch must wait for a
    // newer compatible release instead of opening older data with old code.
    this.updater.allowDowngrade = false
  }

  onDownloaded(listener: (candidate: { version: string; compatibility: unknown }) => void): void {
    this.updater.on("update-downloaded", (event) => {
      const metadata = event as typeof event & { piLabCompatibility?: unknown }
      listener({ version: event.version, compatibility: metadata.piLabCompatibility })
    })
  }

  onUnavailable(listener: () => void): void {
    this.updater.on("update-not-available", listener)
  }

  onError(listener: (error: Error) => void): void {
    this.updater.on("error", listener)
  }

  async check(): Promise<void> {
    await this.updater.checkForUpdates()
  }

  install(restart: boolean): void {
    this.updater.autoRunAppAfterInstall = restart
    this.updater.quitAndInstall()
  }
}
