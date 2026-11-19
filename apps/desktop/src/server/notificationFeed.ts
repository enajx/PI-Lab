import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ActivityRegistrySource } from "../main/caffeine/types"
import type {
  NotificationOutcome,
  NotificationPreferences,
  NotificationRequest,
  NotificationSink,
  NotificationSoundId,
} from "../main/notifications"

/**
 * One notification the server decided to send. `info` events (what happened)
 * go into the history and are alerted only when they happen. `request` events
 * (an agent needs the user's input) stay pending until the agent stops waiting
 * or exits, and are alerted again to a client that connects while pending.
 */
export interface NotificationEvent {
  id: string
  at: number
  kind: "info" | "request"
  request: NotificationRequest
  sound: NotificationSoundId
}

/** What a connected client receives on its notification stream. */
export type NotificationStreamMessage =
  | { type: "alert"; event: NotificationEvent }
  | { type: "cleared"; id: string }

const HISTORY_FILE = "notification-history.jsonl"
const HISTORY_LIMIT = 500

/**
 * Server-side notification policy: applies the user's preferences, keeps the
 * history and the pending requests, and fans events out to every client.
 * Clients decide focus suppression, sound and the native banner.
 */
export class NotificationFeed implements NotificationSink {
  readonly #listeners = new Set<(message: NotificationStreamMessage) => void>()
  readonly #pending = new Map<string, NotificationEvent>()
  readonly #historyPath: string
  #sequence = 0
  #unsubscribe: (() => void) | null = null

  constructor(
    dataDir: string,
    private readonly getPreferences: () => NotificationPreferences,
    private readonly suppress: boolean,
  ) {
    this.#historyPath = join(dataDir, HISTORY_FILE)
  }

  /** Clear a pending request once its agent no longer waits (answered, withdrawn or exited). */
  watch(activity: ActivityRegistrySource): void {
    this.#unsubscribe = activity.subscribe(({ snapshot }) => {
      const waiting = new Set(
        snapshot.sessions
          .filter((session) => session.state === "waiting")
          .map((session) => session.sessionId),
      )
      for (const [id, event] of this.#pending) {
        const target = event.request.target
        if (target.type === "agent" && waiting.has(target.sessionId)) continue
        this.#pending.delete(id)
        this.#publish({ type: "cleared", id })
      }
    })
  }

  notify(request: NotificationRequest): NotificationOutcome {
    const preferences = this.getPreferences()
    if (this.suppress || preferences.muted) return "muted"
    const setting = preferences[request.eventType]
    if (!setting.enabled) return "disabled"
    this.#sequence += 1
    const event: NotificationEvent = {
      id: `${Date.now()}-${this.#sequence}`,
      at: Date.now(),
      kind: request.eventType === "agentInput" ? "request" : "info",
      request,
      sound: setting.sound,
    }
    if (event.kind === "request") this.#pending.set(event.id, event)
    else this.#remember(event)
    this.#publish({ type: "alert", event })
    return "delivered"
  }

  /** A request while it is still pending, or null. */
  pending(id: string): NotificationEvent | null {
    return this.#pending.get(id) ?? null
  }

  /**
   * Take a pending request for answering: it stops being pending and clears
   * on every client. Null when it is no longer pending (already answered,
   * withdrawn or its agent exited), so only the first answer gets it.
   */
  take(id: string): NotificationEvent | null {
    const event = this.#pending.get(id)
    if (!event) return null
    this.#pending.delete(id)
    this.#publish({ type: "cleared", id })
    return event
  }

  /**
   * Stream for one client: first every pending request (so a client that was
   * off is alerted to them), then live messages. Info events missed while
   * the client was off are not re-sent; they are in {@link history}.
   */
  subscribe(listener: (message: NotificationStreamMessage) => void): () => void {
    for (const event of this.#pending.values()) listener({ type: "alert", event })
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Information events, newest first. */
  history(): NotificationEvent[] {
    if (!existsSync(this.#historyPath)) return []
    return readFileSync(this.#historyPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as NotificationEvent)
      .reverse()
  }

  dispose(): void {
    this.#unsubscribe?.()
    this.#listeners.clear()
  }

  #remember(event: NotificationEvent): void {
    appendFileSync(this.#historyPath, `${JSON.stringify(event)}\n`, { mode: 0o600 })
    const lines = readFileSync(this.#historyPath, "utf8").split("\n").filter(Boolean)
    if (lines.length > HISTORY_LIMIT) {
      writeFileSync(this.#historyPath, `${lines.slice(-HISTORY_LIMIT).join("\n")}\n`)
    }
  }

  #publish(message: NotificationStreamMessage): void {
    for (const listener of this.#listeners) listener(message)
  }
}
