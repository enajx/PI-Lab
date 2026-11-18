import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The server's start steps, written to `server-start.json` in the data folder
 * so the desktop app can tell a slow start (steps still advance) from a stuck
 * one (see main/server/launcher.ts).
 */
export const SERVER_START_FILE = "server-start.json"

export type ServerStartStep = "starting" | "migrating" | "reconciling" | "listening"

export interface ServerStartProgress {
  pid: number
  step: ServerStartStep
  /** When the step began (ms since epoch). */
  at: number
}

/** Record that this server process began `step`. */
export function writeStartStep(dataDir: string, step: ServerStartStep): void {
  const progress: ServerStartProgress = { pid: process.pid, step, at: Date.now() }
  writeFileSync(join(dataDir, SERVER_START_FILE), JSON.stringify(progress))
}

/** The last start step a server wrote, or null when none wrote one since the file was cleared. */
export function readStartProgress(dataDir: string): ServerStartProgress | null {
  const path = join(dataDir, SERVER_START_FILE)
  if (!existsSync(path)) return null
  const text = readFileSync(path, "utf8").trim()
  return text ? (JSON.parse(text) as ServerStartProgress) : null
}
