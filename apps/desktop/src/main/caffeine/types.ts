import type {
  ActivityClock,
  ActivityRegistryChange,
  ActivityRegistrySnapshot,
  ActivityScheduler,
} from "../activity"

export const CAFFEINE_GRACE_MS = 15 * 60 * 1_000
export const CAFFEINE_AUDIT_MS = 15 * 60 * 1_000

export type CaffeineMode = "off" | "on" | "auto"
export type CaffeineScope = "system-only" | "system-plus-display"
export type PowerBlockerKind = "prevent-app-suspension" | "prevent-display-sleep"

export interface CaffeineSettings {
  mode: CaffeineMode
  scope: CaffeineScope
}

export interface CaffeineStatus extends CaffeineSettings {
  held: boolean
}

export interface PowerSaveBlockerAdapter {
  start(kind: PowerBlockerKind): number
  stop(id: number): void
  isStarted(id: number): boolean
}

export interface ActivityRegistrySource {
  snapshot(): ActivityRegistrySnapshot
  subscribe(listener: (change: ActivityRegistryChange) => void): () => void
}

export interface CaffeineControllerDependencies {
  power: PowerSaveBlockerAdapter
  clock: ActivityClock
  scheduler: ActivityScheduler
  activity: ActivityRegistrySource
  initialSettings: CaffeineSettings
}

export interface CaffeineControllerPort {
  status(): CaffeineStatus
  configure(settings: CaffeineSettings): CaffeineStatus
  markTerminalActivity(): void
  beginMeaningfulActivity(tag: string): () => void
}
