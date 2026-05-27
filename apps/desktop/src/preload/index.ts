import { contextBridge } from "electron"
import { exposeElectronTRPC } from "trpc-electron/main"

/**
 * Preload bridge. `exposeElectronTRPC()` opens the IPC channel the renderer's
 * `ipcLink` talks to — it MUST run before any other `contextBridge` expose so
 * the channel is in place when the renderer mounts.
 *
 * Runs under `contextIsolation: true` + `sandbox: true`: nothing from Node leaks
 * to the page except the small, explicit surface below.
 */
exposeElectronTRPC()

contextBridge.exposeInMainWorld("skipper", {
  platform: process.platform,
})
