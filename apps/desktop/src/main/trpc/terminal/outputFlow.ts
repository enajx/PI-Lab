import type {
  AttachResult,
  DataEvent,
  ExitEvent,
  ResizeEvent,
  ResumePoint,
} from "@pi-lab/pty-daemon"

/**
 * Terminal output flow control for one client WebSocket (md/branch-connection-layer.md,
 * "Flow control"). The server never pauses a program: it always reads the
 * daemon's output. Each `terminal.output` subscription is a stream with an ack
 * window; the connection has a cap on the bytes in flight (sent, not yet acked
 * by the client) over all its streams. Streams take turns in chunks; a stream
 * whose backlog grows past {@link OUTPUT_BACKLOG_BYTES} drops it and later
 * sends the daemon's latest screen instead (a skip).
 *
 * Provisional values (user, 2026-11-18), checked in the flood run.
 */

/** Bytes in flight per stream before it stops getting turns. */
export const OUTPUT_WINDOW_BYTES = 128 * 1024
/** Upper and lower bound of the per-connection cap; it starts at the upper bound. */
export const CONNECTION_CAP_MAX_BYTES = 256 * 1024
export const CONNECTION_CAP_MIN_BYTES = 32 * 1024
/** Bytes a stream may hold unsent before it skips to the latest screen. */
export const OUTPUT_BACKLOG_BYTES = 512 * 1024
/** Most bytes of `data` one turn sends. */
export const OUTPUT_CHUNK_BYTES = 16 * 1024
/** Every event costs this much on top of its bytes, so tiny events cannot pass the limits. */
export const EVENT_COST_BYTES = 128
/**
 * Adaptive cap: the cap is the measured drain rate (acked bytes per second)
 * times this, so the data in flight takes about this long to drain, well under
 * the 3 s pong timeout.
 */
export const DRAIN_TARGET_MS = 1_000
/** Length of one drain-rate measurement. */
export const DRAIN_SAMPLE_MS = 250
/** A terminal typed in this recently goes ahead of other terminals' output. */
export const TYPING_PRIORITY_MS = 3_000

/** What a stream sends: a start (replay or snapshot) or a daemon event, in daemon order. */
export type FlowItem = { kind: "start"; result: AttachResult } | DataEvent | ResizeEvent | ExitEvent

/** Bytes an item counts against the window, the cap and the backlog. */
function costOf(item: FlowItem): number {
  switch (item.kind) {
    case "start": {
      const screen = item.result.start.mode === "replay" ? 0 : item.result.start.screen.length
      return screen + item.result.start.bytes.length + EVENT_COST_BYTES
    }
    case "data":
      return item.bytes.length + EVENT_COST_BYTES
    default:
      return EVENT_COST_BYTES
  }
}

export interface OutputStreamOptions {
  /** Random per subscription, from the client; acks name it. */
  streamId: string
  sessionId: string
  /** The client holds skips (a selection, or the view is scrolled up). */
  holdSkip: boolean
  /** When a client last typed in this session (epoch ms), or null. */
  typedAt: () => number | null
  /** Send one item to the client now. */
  deliver: (item: FlowItem) => void
  /**
   * Ask the daemon for the latest screen for a client at `from` (the point
   * after everything sent; null before the first start): a refresh when the
   * daemon can make one, else a snapshot. Answer with
   * {@link OutputStream.snapshotReady} at the reply boundary, or
   * {@link OutputStream.snapshotFailed}.
   */
  requestSnapshot: (from: ResumePoint | null) => void
}

/** Per-stream numbers for the test route. */
export interface OutputStreamStats {
  streamId: string
  sessionId: string
  inFlightBytes: number
  backlogBytes: number
  skips: number
  skipPending: boolean
}

/** Per-connection numbers for the test route. */
export interface ConnectionFlowStats {
  capBytes: number
  lowestCapBytes: number
  inFlightBytes: number
  /** Skips of every stream this connection had, ended ones included. */
  skips: number
  streams: OutputStreamStats[]
}

/** One `terminal.output` subscription's flow state. Created by {@link ConnectionFlow.open}. */
export class OutputStream {
  readonly streamId: string
  readonly sessionId: string
  holdSkip: boolean
  inFlightBytes = 0
  skips = 0
  readonly #options: OutputStreamOptions
  readonly #flow: ConnectionFlow
  #backlog: FlowItem[] = []
  #backlogBytes = 0
  /** Items sent and not yet acked: the offset the client has consumed after each, and its cost. */
  #inFlight: { end: number; cost: number }[] = []
  /** The consumed offset after the last item sent. */
  #sentEnd = 0
  /** The client's resume point once it applied everything sent; null before the first start. */
  #sentPoint: ResumePoint | null = null
  /**
   * live: send the backlog in turns. skipPending: the backlog was dropped;
   * drop new output until the next turn asks for a snapshot. snapshotting: a
   * snapshot was asked for; drop output until its reply boundary.
   */
  #state: "live" | "skipPending" | "snapshotting" = "live"
  /** An exit seen while skipping, sent after the snapshot. */
  #exitAfterSkip: ExitEvent | null = null
  #closed = false

  constructor(flow: ConnectionFlow, options: OutputStreamOptions) {
    this.#flow = flow
    this.#options = options
    this.streamId = options.streamId
    this.sessionId = options.sessionId
    this.holdSkip = options.holdSkip
  }

  /** Queue a start or a daemon event for this stream. */
  push(item: FlowItem): void {
    if (this.#closed) return
    if (this.#state !== "live") {
      // Skipping: the snapshot will hold this output. An exit still goes out after it.
      if (item.kind === "exit") this.#exitAfterSkip = item
      return
    }
    this.#backlog.push(item)
    this.#backlogBytes += costOf(item)
    if (this.#backlogBytes > OUTPUT_BACKLOG_BYTES && item.kind !== "exit") {
      this.#backlog = []
      this.#backlogBytes = 0
      this.#state = "skipPending"
      this.skips += 1
      this.#flow.skipCount += 1
    }
    this.#flow.run()
  }

  /** The skip's snapshot, at the daemon's reply boundary: later events follow it. */
  snapshotReady(result: AttachResult): void {
    if (this.#closed || this.#state !== "snapshotting") return
    this.#state = "live"
    this.#backlog = [{ kind: "start", result }]
    this.#backlogBytes = costOf(this.#backlog[0] as FlowItem)
    if (this.#exitAfterSkip !== null) this.#backlog.push(this.#exitAfterSkip)
    this.#exitAfterSkip = null
    this.#flow.run()
  }

  /** The snapshot could not be taken; an exit seen meanwhile still goes out. */
  snapshotFailed(): void {
    if (this.#closed || this.#state !== "snapshotting") return
    if (this.#exitAfterSkip !== null) {
      this.#state = "live"
      this.#backlog = [this.#exitAfterSkip]
      this.#exitAfterSkip = null
      this.#flow.run()
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#flow.unregister(this)
  }

  stats(): OutputStreamStats {
    return {
      streamId: this.streamId,
      sessionId: this.sessionId,
      inFlightBytes: this.inFlightBytes,
      backlogBytes: this.#backlogBytes,
      skips: this.skips,
      skipPending: this.#state !== "live",
    }
  }

  /** Remove acked items; returns the bytes freed. */
  ack(offset: number, holdSkip: boolean): number {
    this.holdSkip = holdSkip
    let freed = 0
    while (this.#inFlight.length > 0 && (this.#inFlight[0]?.end ?? 0) <= offset) {
      freed += (this.#inFlight.shift() as { cost: number }).cost
    }
    this.inFlightBytes -= freed
    return freed
  }

  /** It has something to send now, or a snapshot to ask for. */
  hasWork(): boolean {
    if (this.#closed) return false
    if (this.#state === "skipPending") return !this.holdSkip
    return this.#state === "live" && this.#backlog.length > 0
  }

  /** It has work and room in its window. */
  canSend(): boolean {
    return this.inFlightBytes < OUTPUT_WINDOW_BYTES && this.hasWork()
  }

  typedRecently(now: number): boolean {
    const at = this.#options.typedAt()
    return at !== null && now - at < TYPING_PRIORITY_MS
  }

  /** Take one turn: send one item (data joined up to a chunk). Returns the bytes now in flight for it. */
  turn(): number {
    if (this.#state === "skipPending") {
      this.#state = "snapshotting"
      this.#options.requestSnapshot(this.#sentPoint)
      return 0
    }
    const item = this.#take()
    if (item === null) return 0
    const cost = costOf(item)
    if (item.kind === "start") {
      this.#sentEnd = item.result.start.offset + item.result.start.bytes.length
      this.#sentPoint = {
        generation: item.result.generation,
        offset: this.#sentEnd,
        revision: item.result.revision,
      }
    } else if (item.kind === "data") {
      this.#sentEnd = item.offset + item.bytes.length
      if (this.#sentPoint !== null) this.#sentPoint = { ...this.#sentPoint, offset: this.#sentEnd }
    } else if (item.kind === "resize") {
      this.#sentEnd = item.offset
      if (this.#sentPoint !== null)
        this.#sentPoint = { ...this.#sentPoint, offset: item.offset, revision: item.revision }
    }
    this.#inFlight.push({ end: this.#sentEnd, cost })
    this.inFlightBytes += cost
    this.#options.deliver(item)
    return cost
  }

  /** The next item to send: a replay start or data at most one chunk long, joining data. */
  #take(): FlowItem | null {
    const first = this.#backlog.shift()
    if (first === undefined) return null
    this.#backlogBytes -= costOf(first)
    if (first.kind === "start" && first.result.start.mode === "replay") {
      // Replay bytes go out in chunks: the start with the first one, the rest as data.
      const { start } = first.result
      if (start.bytes.length <= OUTPUT_CHUNK_BYTES) return first
      const rest: DataEvent = {
        kind: "data",
        sessionId: this.sessionId,
        generation: first.result.generation,
        offset: start.offset + OUTPUT_CHUNK_BYTES,
        bytes: start.bytes.subarray(OUTPUT_CHUNK_BYTES),
      }
      this.#unshift(rest)
      return {
        kind: "start",
        result: {
          ...first.result,
          start: { ...start, bytes: start.bytes.subarray(0, OUTPUT_CHUNK_BYTES) },
        },
      }
    }
    if (first.kind !== "data") return first
    const parts = [first.bytes]
    let length = first.bytes.length
    if (length > OUTPUT_CHUNK_BYTES) {
      this.#unshift({
        ...first,
        offset: first.offset + OUTPUT_CHUNK_BYTES,
        bytes: first.bytes.subarray(OUTPUT_CHUNK_BYTES),
      })
      return { ...first, bytes: first.bytes.subarray(0, OUTPUT_CHUNK_BYTES) }
    }
    while (length < OUTPUT_CHUNK_BYTES) {
      const next = this.#backlog[0]
      if (next?.kind !== "data") break
      this.#backlog.shift()
      this.#backlogBytes -= costOf(next)
      const room = OUTPUT_CHUNK_BYTES - length
      if (next.bytes.length > room) {
        parts.push(next.bytes.subarray(0, room))
        this.#unshift({ ...next, offset: next.offset + room, bytes: next.bytes.subarray(room) })
        length += room
        break
      }
      parts.push(next.bytes)
      length += next.bytes.length
    }
    return { ...first, bytes: parts.length === 1 ? first.bytes : Buffer.concat(parts, length) }
  }

  #unshift(item: FlowItem): void {
    this.#backlog.unshift(item)
    this.#backlogBytes += costOf(item)
  }
}

/**
 * The scheduler of one client connection: streams take turns while the
 * connection's bytes in flight are under its cap. A terminal typed in within
 * {@link TYPING_PRIORITY_MS} goes first and may also send past the cap
 * (limited by its own window), so an echo does not wait for other terminals'
 * acks; the others go round robin.
 *
 * Adaptive cap: over each busy period of {@link DRAIN_SAMPLE_MS}, the drain
 * rate is the bytes acked divided by the time. If output waited in that
 * period (held back by a window or the cap), the rate is what the link and
 * the client can take, and the cap becomes rate x {@link DRAIN_TARGET_MS};
 * otherwise the rate only shows how much there was to send, and the cap can
 * only grow to that. Always between the min and max bounds.
 */
export class ConnectionFlow {
  capBytes = CONNECTION_CAP_MAX_BYTES
  lowestCapBytes = CONNECTION_CAP_MAX_BYTES
  inFlightBytes = 0
  skipCount = 0
  readonly #streams = new Map<string, OutputStream>()
  #order: OutputStream[] = []
  #cursor = 0
  #running = false
  #sampleStart = 0
  #sampleAcked = 0
  #sampleLimited = false

  open(options: OutputStreamOptions): OutputStream {
    if (this.#streams.has(options.streamId)) {
      throw new Error(
        `terminal output stream ${options.streamId} is already open on this connection`,
      )
    }
    const stream = new OutputStream(this, options)
    this.#streams.set(stream.streamId, stream)
    this.#order.push(stream)
    return stream
  }

  unregister(stream: OutputStream): void {
    if (this.#streams.get(stream.streamId) !== stream) return
    this.#streams.delete(stream.streamId)
    this.#order = this.#order.filter((entry) => entry !== stream)
    this.inFlightBytes -= stream.inFlightBytes
    this.run()
  }

  /**
   * The client applied everything before `offset` on this stream. Returns
   * false for a stream that is not open here (ended, or never existed).
   */
  ack(streamId: string, offset: number, holdSkip: boolean): boolean {
    const stream = this.#streams.get(streamId)
    if (!stream) return false
    const freed = stream.ack(offset, holdSkip)
    this.inFlightBytes -= freed
    this.#sampleAcked += freed
    const now = Date.now()
    const elapsed = now - this.#sampleStart
    if (elapsed >= DRAIN_SAMPLE_MS) {
      const target = Math.min(
        CONNECTION_CAP_MAX_BYTES,
        Math.max(CONNECTION_CAP_MIN_BYTES, (this.#sampleAcked / elapsed) * DRAIN_TARGET_MS),
      )
      this.capBytes = Math.round(this.#sampleLimited ? target : Math.max(this.capBytes, target))
      this.lowestCapBytes = Math.min(this.lowestCapBytes, this.capBytes)
      this.#startSample(now)
    }
    this.run()
    return true
  }

  /** Give turns until no stream can send or the cap is reached. */
  run(): void {
    if (this.#running) return
    this.#running = true
    for (;;) {
      // Over the cap, only a terminal typed in recently may send (its window still applies).
      const next = this.#pick(this.inFlightBytes >= this.capBytes)
      if (next === null) break
      if (this.inFlightBytes === 0) this.#startSample(Date.now())
      this.inFlightBytes += next.turn()
    }
    // Output left waiting: held back by a window or the cap.
    if (this.#order.some((stream) => stream.hasWork())) this.#sampleLimited = true
    this.#running = false
  }

  stats(): ConnectionFlowStats {
    return {
      capBytes: this.capBytes,
      lowestCapBytes: this.lowestCapBytes,
      inFlightBytes: this.inFlightBytes,
      skips: this.skipCount,
      streams: this.#order.map((stream) => stream.stats()),
    }
  }

  #startSample(now: number): void {
    this.#sampleStart = now
    this.#sampleAcked = 0
    this.#sampleLimited = false
  }

  /**
   * The next stream to send: a recently typed-in one first, else round robin.
   * `typedOnly` (the connection is at its cap) allows only typed-in ones.
   */
  #pick(typedOnly: boolean): OutputStream | null {
    const count = this.#order.length
    if (count === 0) return null
    const now = Date.now()
    let fallback: number | null = null
    for (let step = 0; step < count; step++) {
      const index = (this.#cursor + step) % count
      const stream = this.#order[index] as OutputStream
      if (!stream.canSend()) continue
      if (stream.typedRecently(now)) {
        this.#cursor = (index + 1) % count
        return stream
      }
      fallback ??= index
    }
    if (fallback === null || typedOnly) return null
    this.#cursor = (fallback + 1) % count
    return this.#order[fallback] as OutputStream
  }
}
