import { spawnSync } from "node:child_process"
import { lstatSync } from "node:fs"

/**
 * Startup side of the Alpha reset daemon check (see alphaResetGuard.ts). Kept
 * free of the daemon client so the quick-edit entry stays light.
 */

/** Daemon entry argument that runs the reset check instead of serving. */
export const ALPHA_RESET_PROBE_FLAG = "--alpha-reset-probe"

/**
 * Run the same check synchronously, so the Alpha reset can finish before
 * Electron is ready. Starts the bundled daemon entry in probe mode under
 * Electron's Node and throws its refusal. No socket file means no daemon.
 */
export function assertAlphaResetDaemonIdleSync(daemonEntry: string, socketPath: string): void {
  const socketPresent = (() => {
    try {
      lstatSync(socketPath)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
  })()
  if (!socketPresent) return
  const result = spawnSync(process.execPath, [daemonEntry, ALPHA_RESET_PROBE_FLAG, socketPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 10_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(
      result.stderr.trim() ||
        `Checking prior Alpha terminals and jobs failed (exit ${result.status ?? result.signal}).`,
    )
}
