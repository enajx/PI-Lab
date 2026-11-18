import { type ChildProcess, spawn } from "node:child_process"
import type { PowerBlockerKind, PowerSaveBlockerAdapter } from "../main/caffeine/types"

export type SpawnFn = (command: string, args: string[]) => ChildProcess

const CAFFEINATE = "/usr/bin/caffeinate"

/** Arguments for `caffeinate`. `-w` ends it when this process dies. */
export function caffeinateArgs(kind: PowerBlockerKind, pid: number): string[] {
  const flags = kind === "prevent-display-sleep" ? ["-d", "-i"] : ["-i"]
  return [...flags, "-w", String(pid)]
}

/** Power blocker that runs one `caffeinate` child process per blocker. */
export function createCaffeinateAdapter(spawnFn: SpawnFn): PowerSaveBlockerAdapter {
  const children = new Map<number, { child: ChildProcess; alive: boolean }>()
  let nextId = 1

  return {
    start(kind) {
      if (process.platform !== "darwin") {
        throw new Error(
          `Keeping the machine awake is only supported on macOS for now (platform: ${process.platform}).`,
        )
      }
      const child = spawnFn(CAFFEINATE, caffeinateArgs(kind, process.pid))
      const entry = { child, alive: true }
      child.once("exit", () => {
        entry.alive = false
      })
      child.once("error", () => {
        entry.alive = false
      })
      const id = nextId++
      children.set(id, entry)
      return id
    },
    stop(id) {
      const entry = children.get(id)
      if (!entry) return
      children.delete(id)
      entry.alive = false
      entry.child.kill()
    },
    isStarted(id) {
      return children.get(id)?.alive ?? false
    },
  }
}

export const caffeinateAdapter: PowerSaveBlockerAdapter = createCaffeinateAdapter((command, args) =>
  spawn(command, args, { stdio: "ignore" }),
)
