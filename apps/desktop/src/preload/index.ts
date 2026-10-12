import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron"
import { exposeElectronTRPC } from "trpc-electron/main"
import {
  isShutdownRequest,
  isShutdownResponse,
  SHUTDOWN_REQUEST_CHANNEL,
  SHUTDOWN_RESPONSE_CHANNEL,
  type ShutdownBridge,
  type ShutdownRequest,
  type ShutdownResponse,
} from "../shared/shutdown"

/**
 * Preload bridge. `exposeElectronTRPC()` opens the IPC channel the renderer's
 * `ipcLink` talks to — it MUST run before any other `contextBridge` expose so
 * the channel is in place when the renderer mounts.
 *
 * Runs under `contextIsolation: true` + `sandbox: true`: nothing from Node leaks
 * to the page except the small, explicit surface below.
 */
if (process.isMainFrame) {
  exposeElectronTRPC()

  const shutdown: ShutdownBridge = {
    subscribe(listener: (request: ShutdownRequest) => void): () => void {
      const receive = (_event: IpcRendererEvent, value: unknown): void => {
        if (isShutdownRequest(value)) listener({ requestId: value.requestId, intent: value.intent })
      }
      ipcRenderer.on(SHUTDOWN_REQUEST_CHANNEL, receive)
      return () => ipcRenderer.removeListener(SHUTDOWN_REQUEST_CHANNEL, receive)
    },
    respond(response: ShutdownResponse): void {
      if (!isShutdownResponse(response)) return
      ipcRenderer.send(SHUTDOWN_RESPONSE_CHANNEL, {
        requestId: response.requestId,
        allow: response.allow,
      })
    },
  }

  contextBridge.exposeInMainWorld("piLab", {
    platform: process.platform,
    shutdown,
  })
}
