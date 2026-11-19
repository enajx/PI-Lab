import { z } from "zod"

/**
 * A client-made ID for one "start agent" action. The client sends the same ID
 * again when it retries after a lost reply, and the server returns the first
 * start's result instead of starting a second agent.
 */
export const launchIdSchema = z.string().min(1).max(200)

/** How many launch results the server keeps; older ones are forgotten first. */
const LAUNCH_LIMIT = 500

/**
 * Launch ID → the start's result, for the server's lifetime (in memory only,
 * bounded to {@link LAUNCH_LIMIT}). A repeat while the first start still runs
 * gets the same pending result. A start that failed is forgotten, so a retry
 * runs it again.
 */
export class LaunchRegistry {
  readonly #results = new Map<string, Promise<unknown>>()

  /** Run `start` once per `procedure` and `launchId`; without an ID it always runs. */
  run<T>(procedure: string, launchId: string | undefined, start: () => Promise<T>): Promise<T> {
    if (launchId === undefined) return start()
    const key = `${procedure}\n${launchId}`
    const existing = this.#results.get(key)
    if (existing) return existing as Promise<T>
    const result = start()
    this.#results.set(key, result)
    result.catch(() => {
      if (this.#results.get(key) === result) this.#results.delete(key)
    })
    while (this.#results.size > LAUNCH_LIMIT) {
      const oldest = this.#results.keys().next().value
      if (oldest === undefined) break
      this.#results.delete(oldest)
    }
    return result
  }
}

/** The server process's launch registry (one per process, so one per server lifetime). */
export const launches = new LaunchRegistry()
