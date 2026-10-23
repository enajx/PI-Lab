export const UPDATE_SNAPSHOT_CHANNEL = "updates:snapshot"
export const UPDATE_CHECK_CHANNEL = "updates:check"
export const UPDATE_CHANGED_CHANNEL = "updates:changed"

export interface UpdateSnapshot {
  available: boolean
  checking: boolean
  message: string | null
  revision: number
}

export interface UpdatesBridge {
  snapshot(): Promise<UpdateSnapshot>
  check(): Promise<void>
  subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void
}
