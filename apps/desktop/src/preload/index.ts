import { contextBridge, type IpcRendererEvent, ipcRenderer, webUtils } from "electron"
import { ELECTRON_TRPC_CHANNEL } from "trpc-electron/main"
import {
  APP_ICON_GET_CHANNEL,
  APP_ICON_IDENTITY_CHANNEL,
  APP_ICON_PREVIEW_CHANNEL,
  APP_ICON_SET_CHANNEL,
  type AppIconBridge,
} from "../shared/appIcon"
import {
  BACKGROUND_TRAY_CHANGED_CHANNEL,
  BACKGROUND_TRAY_OPEN_DASHBOARD_CHANNEL,
  BACKGROUND_TRAY_OPEN_FILE_CHANNEL,
  BACKGROUND_TRAY_OPEN_PROJECT_CHANNEL,
  BACKGROUND_TRAY_RESTART_TO_UPDATE_CHANNEL,
  BACKGROUND_TRAY_SNAPSHOT_CHANNEL,
  type BackgroundTrayBridge,
  type BackgroundTraySnapshot,
} from "../shared/backgroundTray"
import {
  CLOSE_TAB_REQUEST_CHANNEL,
  CLOSE_TAB_RESPONSE_CHANNEL,
  type CloseTabBridge,
  type CloseTabRequest,
  isCloseTabRequest,
  isCloseTabResponse,
} from "../shared/closeTab"
import { INTERFACE_LANGUAGE_CHANNEL, isInterfaceLanguage } from "../shared/interfaceLanguage"
import {
  QUICK_EDIT_CLOSE_CHANNEL,
  QUICK_EDIT_CURRENT_CHANNEL,
  QUICK_EDIT_EDITOR_VIM_CHANNEL,
  QUICK_EDIT_OPEN_CHANNEL,
  QUICK_EDIT_PYTHON_KILL_CHANNEL,
  QUICK_EDIT_PYTHON_OPTIONS_CHANNEL,
  QUICK_EDIT_PYTHON_RUN_CHANNEL,
  QUICK_EDIT_PYTHON_SELECT_CHANNEL,
  QUICK_EDIT_READ_CHANNEL,
  QUICK_EDIT_READY_CHANNEL,
  QUICK_EDIT_RESOLVE_ROUTE_CHANNEL,
  QUICK_EDIT_ROUTE_CHANNEL,
  QUICK_EDIT_ROUTES_READY_CHANNEL,
  QUICK_EDIT_SAVE_CHANNEL,
  QUICK_EDIT_SAVE_UNTITLED_CHANNEL,
  QUICK_EDIT_SHOW_FULL_CHANNEL,
  QUICK_EDIT_SHOW_SETTINGS_CHANNEL,
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
import {
  UPDATE_CHANGED_CHANNEL,
  UPDATE_CHECK_CHANNEL,
  UPDATE_SNAPSHOT_CHANNEL,
  type UpdateSnapshot,
  type UpdatesBridge,
} from "../shared/updates"
import { createDocumentTrpcBridge } from "./trpcBridge"

/**
 * Preload bridge. The document-scoped bridge opens the IPC channel the renderer's
 * `ipcLink` talks to — it MUST run before any other `contextBridge` expose so
 * the channel is in place when the renderer mounts.
 *
 * Runs under `contextIsolation: true` + `sandbox: true`: nothing from Node leaks
 * to the page except the small, explicit surface below.
 */
if (process.isMainFrame) {
  contextBridge.exposeInMainWorld(
    "electronTRPC",
    createDocumentTrpcBridge(globalThis.crypto.randomUUID(), {
      send: (message) => ipcRenderer.send(ELECTRON_TRPC_CHANNEL, message),
      onMessage: (listener) => {
        ipcRenderer.on(ELECTRON_TRPC_CHANNEL, (_event, message) => listener(message))
      },
    }),
  )

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

  const closeTab: CloseTabBridge = {
    subscribe(listener: (request: CloseTabRequest) => void): () => void {
      const receive = (_event: IpcRendererEvent, value: unknown): void => {
        if (isCloseTabRequest(value)) listener({ requestId: value.requestId })
      }
      ipcRenderer.on(CLOSE_TAB_REQUEST_CHANNEL, receive)
      return () => ipcRenderer.removeListener(CLOSE_TAB_REQUEST_CHANNEL, receive)
    },
    respond(response): void {
      if (!isCloseTabResponse(response)) return
      ipcRenderer.send(CLOSE_TAB_RESPONSE_CHANNEL, {
        requestId: response.requestId,
        handled: response.handled,
      })
    },
  }

  const quickEdit: QuickEditBridge = {
    current: () => ipcRenderer.invoke(QUICK_EDIT_CURRENT_CHANNEL),
    read: (id) => ipcRenderer.invoke(QUICK_EDIT_READ_CHANNEL, id),
    stat: (id) => ipcRenderer.invoke(QUICK_EDIT_STAT_CHANNEL, id),
    save: (id, content, baseline, overwrite) =>
      ipcRenderer.invoke(QUICK_EDIT_SAVE_CHANNEL, id, content, baseline, overwrite),
    saveUntitled: (content) => ipcRenderer.invoke(QUICK_EDIT_SAVE_UNTITLED_CHANNEL, content),
    pythonOptions: (id) => ipcRenderer.invoke(QUICK_EDIT_PYTHON_OPTIONS_CHANNEL, id),
    pythonSelect: (id, path) => ipcRenderer.invoke(QUICK_EDIT_PYTHON_SELECT_CHANNEL, id, path),
    pythonRun: (id, cols, rows) =>
      ipcRenderer.invoke(QUICK_EDIT_PYTHON_RUN_CHANNEL, id, cols, rows),
    pythonKill: (sessionId) => ipcRenderer.invoke(QUICK_EDIT_PYTHON_KILL_CHANNEL, sessionId),
    ready: () => ipcRenderer.send(QUICK_EDIT_READY_CHANNEL),
    subscribeEditorVim(listener: (enabled: boolean) => void): () => void {
      const receive = (_event: IpcRendererEvent, value: unknown): void => {
        if (typeof value === "boolean") listener(value)
      }
      ipcRenderer.on(QUICK_EDIT_EDITOR_VIM_CHANNEL, receive)
      return () => ipcRenderer.removeListener(QUICK_EDIT_EDITOR_VIM_CHANNEL, receive)
    },
    close: (id) => ipcRenderer.invoke(QUICK_EDIT_CLOSE_CHANNEL, id),
    showFull: (id) => ipcRenderer.invoke(QUICK_EDIT_SHOW_FULL_CHANNEL, id),
    showSettings: (id) => ipcRenderer.invoke(QUICK_EDIT_SHOW_SETTINGS_CHANNEL, id),
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
    openDashboard: () => ipcRenderer.invoke(BACKGROUND_TRAY_OPEN_DASHBOARD_CHANNEL),
    openProject: (id) => ipcRenderer.invoke(BACKGROUND_TRAY_OPEN_PROJECT_CHANNEL, id),
    openFile: () => ipcRenderer.invoke(BACKGROUND_TRAY_OPEN_FILE_CHANNEL),
    restartToUpdate: () => ipcRenderer.send(BACKGROUND_TRAY_RESTART_TO_UPDATE_CHANNEL),
  }

  const appIcon: AppIconBridge = {
    getChannel: () => ipcRenderer.invoke(APP_ICON_IDENTITY_CHANNEL),
    get: () => ipcRenderer.invoke(APP_ICON_GET_CHANNEL),
    set: (selection) => ipcRenderer.invoke(APP_ICON_SET_CHANNEL, selection),
    preview: (selection) => ipcRenderer.invoke(APP_ICON_PREVIEW_CHANNEL, selection),
  }

  const updates: UpdatesBridge = {
    snapshot: () => ipcRenderer.invoke(UPDATE_SNAPSHOT_CHANNEL),
    check: () => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL),
    subscribe(listener) {
      const receive = (_event: IpcRendererEvent, snapshot: UpdateSnapshot) => listener(snapshot)
      ipcRenderer.on(UPDATE_CHANGED_CHANNEL, receive)
      return () => ipcRenderer.removeListener(UPDATE_CHANGED_CHANNEL, receive)
    },
  }

  contextBridge.exposeInMainWorld("piLab", {
    updates,
    platform: process.platform,
    shutdown,
    closeTab,
    quickEdit,
    backgroundTray,
    appIcon,
    setInterfaceLanguage(language: string): void {
      if (isInterfaceLanguage(language)) ipcRenderer.send(INTERFACE_LANGUAGE_CHANNEL, language)
    },
    getPathForFile(file: File): string {
      return webUtils.getPathForFile(file)
    },
  })
}
