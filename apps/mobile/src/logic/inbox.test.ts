// Inbox rebuild and answer tests. The server here is a fake (FakeFeed) that
// follows the contract of the real NotificationFeed (apps/desktop/src/server/
// notificationFeed.ts) and controlRouter.answerRequest: a new subscription gets
// every pending request first, then live alerts and clears; history holds the
// info events, newest first; a second answer gets "already-answered".
import { describe, expect, it } from "vitest"
import { answerInboxItem } from "./answer"
import { Inbox, type InboxEvent, type InboxSource, type StreamMessage } from "./inbox"

function event(id: string, kind: "info" | "request", sessionId: string): InboxEvent {
  return {
    id,
    at: Number(id.replace(/\D/g, "")) || 1,
    kind,
    request: {
      eventType: kind === "request" ? "agentInput" : "agentTurnCompletion",
      title: kind === "request" ? "Agent needs input" : "Agent finished its turn",
      body: `agent ${sessionId}`,
      target: {
        type: "agent",
        projectId: "p1",
        workspaceId: "w1",
        sessionId,
        agentId: "test",
        origin: "project",
      },
    },
    sound: "default",
  }
}

/** A fake of the server's notification feed, with one source per connection. */
class FakeFeed {
  pending = new Map<string, InboxEvent>()
  infos: InboxEvent[] = []
  listeners = new Set<(message: StreamMessage) => void>()
  /** When set, history() waits until `releaseHistory` is called. */
  holdHistory = false
  #release: (() => void) | null = null

  connect(): InboxSource {
    let open = true
    return {
      subscribe: (handlers) => {
        const listener = (message: StreamMessage) => {
          if (open) handlers.onMessage(message)
        }
        for (const pending of this.pending.values()) listener({ type: "alert", event: pending })
        this.listeners.add(listener)
        handlers.onStarted()
        return () => {
          open = false
          this.listeners.delete(listener)
        }
      },
      history: async () => {
        if (this.holdHistory) await new Promise<void>((resolve) => (this.#release = resolve))
        return [...this.infos].reverse()
      },
    }
  }

  releaseHistory(): void {
    this.#release?.()
  }

  raise(next: InboxEvent): void {
    if (next.kind === "request") this.pending.set(next.id, next)
    else this.infos.push(next)
    for (const listener of this.listeners) listener({ type: "alert", event: next })
  }

  take(id: string): boolean {
    if (!this.pending.delete(id)) return false
    for (const listener of this.listeners) listener({ type: "cleared", id })
    return true
  }

  /** The connection ends: no message reaches the old subscribers. */
  disconnect(): void {
    this.listeners.clear()
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const ids = (inbox: Inbox) => inbox.items().map((item) => item.id)

describe("Inbox rebuild", () => {
  it("drops an answered request, shows a finished agent once and offers the new request", async () => {
    const feed = new FakeFeed()
    const inbox = new Inbox(() => {})
    feed.raise(event("r1", "request", "A"))
    inbox.rebuild(feed.connect())
    await flush()
    expect(ids(inbox)).toEqual(["r1"])

    // The phone is away: A is answered on the desktop, agent B finishes.
    feed.disconnect()
    feed.take("r1")
    feed.raise(event("i2", "info", "B"))

    // Reconnect; agent C starts waiting while the history is being read, and
    // B's notice also arrives live during the read.
    feed.holdHistory = true
    inbox.rebuild(feed.connect())
    expect(inbox.loading()).toBe(true)
    feed.raise(event("r3", "request", "C"))
    for (const listener of feed.listeners)
      listener({ type: "alert", event: event("i2", "info", "B") })
    feed.releaseHistory()
    await flush()

    expect(inbox.loading()).toBe(false)
    expect(ids(inbox)).toEqual(["r3", "i2"])
    const c = inbox.items()[0]
    expect(c?.canAnswer).toBe(true)
    expect(c?.sessionId).toBe("C")
    expect(inbox.items()[1]?.canAnswer).toBe(false)
  })

  it("ignores messages from the subscription of an earlier connection", async () => {
    const feed = new FakeFeed()
    const inbox = new Inbox(() => {})
    const first = feed.connect()
    let staleMessage: ((message: StreamMessage) => void) | null = null
    inbox.rebuild({
      subscribe: (handlers) => {
        staleMessage = handlers.onMessage
        return first.subscribe(handlers)
      },
      history: first.history,
    })
    await flush()
    inbox.rebuild(feed.connect())
    await flush()
    const stale = staleMessage as ((message: StreamMessage) => void) | null
    stale?.({ type: "alert", event: event("r9", "request", "Z") })
    expect(ids(inbox)).toEqual([])
  })

  it("removes a request when the server clears it", async () => {
    const feed = new FakeFeed()
    const inbox = new Inbox(() => {})
    inbox.rebuild(feed.connect())
    await flush()
    feed.raise(event("r1", "request", "A"))
    expect(ids(inbox)).toEqual(["r1"])
    feed.take("r1")
    expect(ids(inbox)).toEqual([])
  })
})

describe("answering a request", () => {
  /** answerRequest as the server does it: the first answer is accepted. */
  function server(feed: FakeFeed) {
    const written: string[] = []
    return {
      written,
      answerRequest: async (input: { requestId: string; text: string }) => {
        if (!feed.take(input.requestId)) return { status: "already-answered" as const }
        written.push(input.text)
        return { status: "accepted" as const }
      },
    }
  }

  it("sends the answer once and the item goes away", async () => {
    const feed = new FakeFeed()
    const inbox = new Inbox(() => {})
    feed.raise(event("r1", "request", "A"))
    inbox.rebuild(feed.connect())
    await flush()
    const api = server(feed)
    const result = await answerInboxItem(api, inbox, "r1", "yes")
    expect(result).toEqual({ status: "accepted", notice: null })
    expect(api.written).toEqual(["yes"])
    expect(ids(inbox)).toEqual([])
  })

  it("removes the item and tells the user when another device answered first", async () => {
    const feed = new FakeFeed()
    const inbox = new Inbox(() => {})
    feed.raise(event("r1", "request", "A"))
    inbox.rebuild(feed.connect())
    await flush()
    // The desktop answers while the phone missed the clear (connection gap).
    feed.disconnect()
    feed.take("r1")
    expect(ids(inbox)).toEqual(["r1"])

    const api = server(feed)
    const result = await answerInboxItem(api, inbox, "r1", "no")
    expect(result.status).toBe("already-answered")
    expect(result.notice).toBe("Another device already answered this request.")
    expect(api.written).toEqual([])
    expect(ids(inbox)).toEqual([])
  })

  it("keeps the item when sending fails", async () => {
    const feed = new FakeFeed()
    const inbox = new Inbox(() => {})
    feed.raise(event("r1", "request", "A"))
    inbox.rebuild(feed.connect())
    await flush()
    const failing = {
      answerRequest: async () => {
        throw new Error("socket closed")
      },
    }
    await expect(answerInboxItem(failing, inbox, "r1", "yes")).rejects.toThrow("socket closed")
    expect(ids(inbox)).toEqual(["r1"])
  })
})
