import { contextBridge, type IpcRendererEvent, ipcRenderer, webUtils } from "electron"
import { exposeElectronTRPC } from "trpc-electron/main"
import {
  BACKGROUND_TRAY_CHANGED_CHANNEL,
  BACKGROUND_TRAY_OPEN_APP_CHANNEL,
  BACKGROUND_TRAY_OPEN_FILE_CHANNEL,
  BACKGROUND_TRAY_OPEN_PROJECT_CHANNEL,
  BACKGROUND_TRAY_QUIT_CHANNEL,
  BACKGROUND_TRAY_SNAPSHOT_CHANNEL,
  type BackgroundTrayBridge,
  type BackgroundTraySnapshot,
} from "../shared/backgroundTray"
import { INTERFACE_LANGUAGE_CHANNEL, isInterfaceLanguage } from "../shared/interfaceLanguage"
import {
  QUICK_EDIT_CLOSE_CHANNEL,
  QUICK_EDIT_CURRENT_CHANNEL,
  QUICK_EDIT_OPEN_CHANNEL,
  QUICK_EDIT_READ_CHANNEL,
  QUICK_EDIT_READY_CHANNEL,
  QUICK_EDIT_RESOLVE_ROUTE_CHANNEL,
  QUICK_EDIT_ROUTE_CHANNEL,
  QUICK_EDIT_ROUTES_READY_CHANNEL,
  QUICK_EDIT_SAVE_CHANNEL,
  QUICK_EDIT_SHOW_FULL_CHANNEL,
  QUICK_EDIT_STAT_CHANNEL,
  type QuickEditBridge,
  type QuickEditTarget,
} from "../shared/quickEdit"
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

  const quickEdit: QuickEditBridge = {
    current: () => ipcRenderer.invoke(QUICK_EDIT_CURRENT_CHANNEL),
    read: (id) => ipcRenderer.invoke(QUICK_EDIT_READ_CHANNEL, id),
    stat: (id) => ipcRenderer.invoke(QUICK_EDIT_STAT_CHANNEL, id),
    save: (id, content, baseline, overwrite) =>
      ipcRenderer.invoke(QUICK_EDIT_SAVE_CHANNEL, id, content, baseline, overwrite),
    ready: () => ipcRenderer.send(QUICK_EDIT_READY_CHANNEL),
    close: (id) => ipcRenderer.invoke(QUICK_EDIT_CLOSE_CHANNEL, id),
    showFull: (id) => ipcRenderer.invoke(QUICK_EDIT_SHOW_FULL_CHANNEL, id),
    resolveRoute: (id) => ipcRenderer.invoke(QUICK_EDIT_RESOLVE_ROUTE_CHANNEL, id),
    routesReady: () => ipcRenderer.invoke(QUICK_EDIT_ROUTES_READY_CHANNEL),
    subscribeOpen(listener: (target: QuickEditTarget) => void): () => void {
      const receive = (_event: IpcRendererEvent, target: QuickEditTarget): void => listener(target)
      ipcRenderer.on(QUICK_EDIT_OPEN_CHANNEL, receive)
      return () => ipcRenderer.removeListener(QUICK_EDIT_OPEN_CHANNEL, receive)
    },
    subscribeRoute(listener: (route: string) => void): () => void {
      const receive = (_event: IpcRendererEvent, route: string): void => listener(route)
      ipcRenderer.on(QUICK_EDIT_ROUTE_CHANNEL, receive)
      return () => ipcRenderer.removeListener(QUICK_EDIT_ROUTE_CHANNEL, receive)
    },
  }

  const backgroundTray: BackgroundTrayBridge = {
    getSnapshot: () => ipcRenderer.invoke(BACKGROUND_TRAY_SNAPSHOT_CHANNEL),
    subscribe(listener: (snapshot: BackgroundTraySnapshot) => void): () => void {
      const receive = (_event: IpcRendererEvent, snapshot: BackgroundTraySnapshot): void =>
        listener(snapshot)
      ipcRenderer.on(BACKGROUND_TRAY_CHANGED_CHANNEL, receive)
      return () => ipcRenderer.removeListener(BACKGROUND_TRAY_CHANGED_CHANNEL, receive)
    },
    openProject: (id) => ipcRenderer.invoke(BACKGROUND_TRAY_OPEN_PROJECT_CHANNEL, id),
    openApp: () => ipcRenderer.invoke(BACKGROUND_TRAY_OPEN_APP_CHANNEL),
    openFile: () => ipcRenderer.invoke(BACKGROUND_TRAY_OPEN_FILE_CHANNEL),
    quit: () => ipcRenderer.send(BACKGROUND_TRAY_QUIT_CHANNEL),
  }

  contextBridge.exposeInMainWorld("piLab", {
    platform: process.platform,
    shutdown,
    quickEdit,
    backgroundTray,
    setInterfaceLanguage(language: string): void {
      if (isInterfaceLanguage(language)) ipcRenderer.send(INTERFACE_LANGUAGE_CHANNEL, language)
    },
    getPathForFile(file: File): string {
      return webUtils.getPathForFile(file)
    },
  })
}
