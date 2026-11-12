import { type ChildProcessByStdio, spawn, spawnSync } from "node:child_process"
import type { Readable } from "node:stream"

/** Seconds the watcher waits between SIGTERM and SIGKILL after PI Lab's main process is gone. */
const WATCHER_GRACE_SECONDS = 3

/**
 * Run by `/bin/sh -c` in front of the command. A background watcher waits on fd 3,
 * a pipe whose other end only PI Lab's main process holds. The pipe closes when main
 * exits for any reason (also a crash or SIGKILL), or when main closes it after the
 * command exits. The watcher then sends SIGTERM to the whole group, waits, and sends
 * SIGKILL. The watcher ignores SIGTERM, so it stays in the group until then; while
 * the command runs the group always has a live process.
 */
const WATCHER = `( trap '' TERM; read -r _ <&3; kill -TERM 0; sleep ${WATCHER_GRACE_SECONDS}; kill -KILL 0 ) </dev/null >/dev/null 2>&1 &
exec 3<&-
exec "$@"`

export interface ProcessGroupOptions {
  cwd: string
  env: NodeJS.ProcessEnv
}

/**
 * A command in its own process group (on Windows, its own process tree), so a
 * stop reaches everything it started. The group also ends when PI Lab's main
 * process dies without cleanup (see {@link WATCHER}).
 */
export class ProcessGroup {
  readonly child: ChildProcessByStdio<null, Readable, Readable>
  /** Resolves when the command exits, or fails to start (`child` emits "error"). */
  readonly exited: Promise<void>
  #ended = false
  #killed = false

  constructor(command: string, args: string[], options: ProcessGroupOptions) {
    const windows = process.platform === "win32"
    this.child = spawn(
      windows ? command : "/bin/sh",
      windows ? args : ["-c", WATCHER, "sh", command, ...args],
      {
        cwd: options.cwd,
        env: options.env,
        detached: !windows,
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    ) as unknown as ChildProcessByStdio<null, Readable, Readable>
    this.exited = new Promise<void>((resolveExited) => {
      const end = (): void => {
        if (this.#ended) return
        this.#ended = true
        // Closing main's end of the pipe lets the watcher end what the command left behind.
        this.child.stdio[3]?.destroy()
        resolveExited()
      }
      this.child.once("exit", end)
      this.child.once("error", end)
    })
  }

  /** True once the command has exited (or failed to start). */
  get ended(): boolean {
    return this.#ended
  }

  /**
   * Signal the whole group. Does nothing once the command has exited or after a
   * SIGKILL: before that the watcher is alive, so the group exists.
   */
  signal(signal: "SIGTERM" | "SIGKILL"): void {
    const pid = this.child.pid
    if (this.#ended || this.#killed || pid === undefined) return
    if (signal === "SIGKILL") this.#killed = true
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true })
      return
    }
    process.kill(-pid, signal)
  }

  /** SIGTERM the group, then SIGKILL it if the command still runs after `graceMs`. */
  async stop(graceMs: number): Promise<void> {
    if (this.#ended) return
    this.signal("SIGTERM")
    const graceful = await Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((resolveGrace) => setTimeout(() => resolveGrace(false), graceMs)),
    ])
    if (!graceful) this.signal("SIGKILL")
    await this.exited
  }
}
