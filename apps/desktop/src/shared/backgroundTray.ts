export const BACKGROUND_TRAY_SNAPSHOT_CHANNEL = "background-tray:snapshot"
export const BACKGROUND_TRAY_CHANGED_CHANNEL = "background-tray:changed"
export const BACKGROUND_TRAY_OPEN_PROJECT_CHANNEL = "background-tray:open-project"
export const BACKGROUND_TRAY_OPEN_APP_CHANNEL = "background-tray:open-app"
export const BACKGROUND_TRAY_OPEN_FILE_CHANNEL = "background-tray:open-file"
export const BACKGROUND_TRAY_QUIT_CHANNEL = "background-tray:quit"

export interface BackgroundTrayProject {
  id: string
  name: string
  state: "working" | "waiting"
}

export interface BackgroundTraySnapshot {
  projects: BackgroundTrayProject[]
}

/** The small native tray window uses this bridge without booting the full app. */
export interface BackgroundTrayBridge {
  getSnapshot(): Promise<BackgroundTraySnapshot>
  subscribe(listener: (snapshot: BackgroundTraySnapshot) => void): () => void
  openProject(id: string): Promise<void>
  openApp(): Promise<void>
  openFile(): Promise<void>
  quit(): void
}
