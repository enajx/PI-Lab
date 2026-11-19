// The Inbox: agents waiting for an answer, and notices of finished work. It is
// rebuilt from the server on every connection and never read from a saved
// cache: the notification stream (which first replays every pending request,
// then sends live alerts and clears) is opened, and once it has started, the
// info history is read. Both are merged by event ID, so an event that arrives
// live during the read and is also in the history is shown once.

/** Where a notification points; only the fields the phone uses. */
export interface InboxTarget {
  type: "agent" | "workflow" | "terminal"
  sessionId?: string
  projectId?: string
  workspaceId?: string
  agentId?: string
  origin?: string
  label?: string
}

/** One server notification event (`notificationEventSchema` in the desktop's clientApi.ts). */
export interface InboxEvent {
  id: string
  at: number
  kind: "info" | "request"
  request: { eventType: string; title: string; body: string; target: InboxTarget }
  sound: string
}

/** One message on the notification stream (`server.onNotification`). */
export type StreamMessage =
  | { type: "alert"; event: InboxEvent; banner?: boolean }
  | { type: "cleared"; id: string }

/** One connection's way to read the feed. */
export interface InboxSource {
  /** Open the stream; returns the function that closes it. */
  subscribe: (handlers: {
    onStarted: () => void
    onMessage: (message: StreamMessage) => void
    onError: (error: unknown) => void
  }) => () => void
  /** Info events, newest first (`server.notificationHistory`). */
  history: () => Promise<InboxEvent[]>
}

/** One row of the Inbox. */
export interface InboxItem {
  id: string
  at: number
  kind: "info" | "request"
  title: string
  body: string
  sessionId: string | null
  projectId: string | null
  /** True for a waiting agent: the row offers the answer action. */
  canAnswer: boolean
}

/** How many info notices the Inbox shows (the server keeps up to 500). */
const SHOWN_NOTICES = 100

function toItem(event: InboxEvent): InboxItem {
  const target = event.request.target
  return {
    id: event.id,
    at: event.at,
    kind: event.kind,
    title: event.request.title,
    body: event.request.body,
    sessionId: target.sessionId ?? null,
    projectId: target.projectId ?? null,
    canAnswer: event.kind === "request" && target.type === "agent",
  }
}

/** The Inbox state for the current connection; `onChange` runs after every change. */
export class Inbox {
  readonly #onChange: () => void
  #requests = new Map<string, InboxItem>()
  #notices = new Map<string, InboxItem>()
  #generation = 0
  #loading = false
  #error: string | null = null
  #close: (() => void) | null = null
  #items: InboxItem[] = []

  constructor(onChange: () => void) {
    this.#onChange = onChange
  }

  /** Forget everything and read the Inbox again from `source` (a new connection). */
  rebuild(source: InboxSource): void {
    this.stop()
    this.#generation += 1
    const generation = this.#generation
    const current = () => generation === this.#generation
    this.#requests = new Map()
    this.#notices = new Map()
    this.#loading = true
    this.#error = null
    this.#changed()
    this.#close = source.subscribe({
      onMessage: (message) => {
        if (current()) this.#apply(message)
      },
      onError: (error) => {
        if (!current()) return
        this.#loading = false
        this.#error = String(error)
        this.#changed()
      },
      onStarted: () => {
        if (!current()) return
        source.history().then(
          (events) => {
            if (!current()) return
            for (const event of events) {
              if (event.kind === "info") this.#notices.set(event.id, toItem(event))
            }
            this.#loading = false
            this.#changed()
          },
          (error: unknown) => {
            if (!current()) return
            this.#loading = false
            this.#error = String(error)
            this.#changed()
          },
        )
      },
    })
  }

  /** Close the stream; later messages from it are ignored. */
  stop(): void {
    this.#generation += 1
    this.#close?.()
    this.#close = null
  }

  /** Remove one item (an answered request). */
  remove(id: string): void {
    if (this.#requests.delete(id) || this.#notices.delete(id)) this.#changed()
  }

  /** Waiting agents first, then notices; each newest first. */
  items(): InboxItem[] {
    return this.#items
  }

  item(id: string): InboxItem | null {
    return this.#requests.get(id) ?? this.#notices.get(id) ?? null
  }

  /** The pending request of a session, or null. */
  requestFor(sessionId: string): InboxItem | null {
    for (const item of this.#requests.values()) if (item.sessionId === sessionId) return item
    return null
  }

  loading(): boolean {
    return this.#loading
  }

  error(): string | null {
    return this.#error
  }

  #apply(message: StreamMessage): void {
    if (message.type === "cleared") {
      this.remove(message.id)
      return
    }
    const item = toItem(message.event)
    if (item.kind === "request") this.#requests.set(item.id, item)
    else this.#notices.set(item.id, item)
    this.#changed()
  }

  #changed(): void {
    const newestFirst = (a: InboxItem, b: InboxItem) => b.at - a.at
    this.#items = [
      ...[...this.#requests.values()].sort(newestFirst),
      ...[...this.#notices.values()].sort(newestFirst).slice(0, SHOWN_NOTICES),
    ]
    this.#onChange()
  }
}
