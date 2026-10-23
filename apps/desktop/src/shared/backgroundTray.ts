export const BACKGROUND_TRAY_SNAPSHOT_CHANNEL = "background-tray:snapshot"
export const BACKGROUND_TRAY_CHANGED_CHANNEL = "background-tray:changed"
export const BACKGROUND_TRAY_OPEN_DASHBOARD_CHANNEL = "background-tray:open-dashboard"
export const BACKGROUND_TRAY_OPEN_PROJECT_CHANNEL = "background-tray:open-project"
export const BACKGROUND_TRAY_OPEN_FILE_CHANNEL = "background-tray:open-file"
export const BACKGROUND_TRAY_RESTART_TO_UPDATE_CHANNEL = "background-tray:restart-to-update"

export interface BackgroundTrayProject {
  id: string
  name: string
  state: "working" | "waiting" | "idle"
}

export interface BackgroundTraySnapshot {
  projects: BackgroundTrayProject[]
  updateVersion?: string | null
}

/** The small native tray window uses this bridge without booting the full app. */
export interface BackgroundTrayBridge {
  getSnapshot(): Promise<BackgroundTraySnapshot>
  subscribe(listener: (snapshot: BackgroundTraySnapshot) => void): () => void
  openDashboard(): Promise<void>
  openProject(id: string): Promise<void>
  openFile(): Promise<void>
  restartToUpdate(): void
}
