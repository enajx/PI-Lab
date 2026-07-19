import { powerSaveBlocker } from "electron"
import type { PowerSaveBlockerAdapter } from "./types"

export const electronPowerSaveBlockerAdapter: PowerSaveBlockerAdapter = {
  start: (kind) => powerSaveBlocker.start(kind),
  stop: (id) => powerSaveBlocker.stop(id),
  isStarted: (id) => powerSaveBlocker.isStarted(id),
}
