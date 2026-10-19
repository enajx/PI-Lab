import { EventEmitter } from "node:events"
import type { AppUpdater } from "electron-updater"
import { describe, expect, test, vi } from "vitest"
import { ElectronUpdateEngine } from "./electronEngine"

/** Exercise the public electron-updater API without opening a network feed. */
function harness() {
  const events = new EventEmitter()
  const updater = Object.assign(events, {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: true,
    allowDowngrade: true,
    channel: null as string | null,
    checkForUpdates: vi.fn(async () => null),
    quitAndInstall: vi.fn(),
  }) as unknown as AppUpdater
  return { events, updater, engine: new ElectronUpdateEngine(updater) }
}

describe("Electron update adapter", () => {
  test("uses the selected macOS channel without staging an old update at Quit", async () => {
    const h = harness()
    h.engine.configure("beta")
    expect(h.updater.channel).toBe("beta")
    expect(h.updater.allowDowngrade).toBe(false)
    expect(h.updater.autoDownload).toBe(true)
    expect(h.updater.autoInstallOnAppQuit).toBe(false)
    await h.engine.check()
    expect(h.updater.checkForUpdates).toHaveBeenCalledOnce()
  })

  test("announces downloaded ZIPs and controls relaunch on approved installation", () => {
    const h = harness()
    const downloaded = vi.fn()
    h.engine.onDownloaded(downloaded)
    const compatibility = { formatVersion: 1, migrations: [] }
    h.events.emit("update-downloaded", { version: "1.2.0", piLabCompatibility: compatibility })
    expect(downloaded).toHaveBeenCalledExactlyOnceWith({ version: "1.2.0", compatibility })
    h.engine.install(false)
    expect(h.updater.autoRunAppAfterInstall).toBe(false)
    expect(h.updater.quitAndInstall).toHaveBeenCalledOnce()
    h.engine.install(true)
    expect(h.updater.autoRunAppAfterInstall).toBe(true)
  })
})
