import type { TerminalOutput } from "../../main/trpc/terminal/terminal"

/**
 * Terminal output with resume, shared by the desktop renderer and any other
 * client (the Expo stand-in in tests). It has no DOM or React code.
 *
 * The terminal owns its resume point: the generation, the next byte its
 * emulator needs, and the screen revision. "Consumed" means applied to the
 * emulator's state (the `write` callback), not drawn. tRPC's automatic
 * resubscription would reuse the last *received* event id, so on a drop this
 * stream ends its subscription and subscribes again with the consumed point,
 * while tRPC reconnects the socket.
 *
 * Flow control (server side in main/trpc/terminal/outputFlow.ts): each
 * subscription has a random stream id; the stream acks the consumed offset
 * (`terminal.ack`) every {@link ACK_EVERY_BYTES} applied, or when its queue
 * is empty. A hidden terminal ends its subscription and subscribes again from
 * its consumed point when shown. While the user has a selection or has
 * scrolled up, the stream asks the server to hold skips.
 */

/** Where the emulator's state stands; see `terminal.output`. */
export interface ResumePoint {
  generation: string
  offset: number
  revision: number
}

/** The emulator calls this stream needs (xterm.js and @xterm/headless both fit). */
export interface TerminalEmulator {
  /** Queue bytes or text; `applied` runs once the emulator's state includes them. */
  write: (data: string | Uint8Array, applied: () => void) => void
  resize: (cols: number, rows: number) => void
}

/** The connection state tRPC reports to a subscription. */
export interface SubscriptionConnectionState {
  state: "idle" | "connecting" | "pending"
  error: unknown
}

export interface OutputSubscriptionHandlers {
  onData: (event: { id: string; data: TerminalOutput }) => void
  /** A TRPCClientError: `data` is set for server errors, absent for a closed socket. */
  onError: (error: { message: string; data?: unknown }) => void
  onConnectionStateChange: (state: SubscriptionConnectionState) => void
}

/** `trpc.terminal.output.subscribe`, from any tRPC client of the server. */
export type SubscribeOutput = (
  input: { sessionId: string; resume: ResumePoint | null; streamId: string; holdSkip: boolean },
  handlers: OutputSubscriptionHandlers,
) => { unsubscribe: () => void }

/** What a `terminal.ack` carries. */
export interface OutputAck {
  streamId: string
  offset: number
  holdSkip: boolean
}

/** `trpc.terminal.ack.mutate`; the stream does not wait for the reply. */
export type AckOutput = (input: OutputAck) => Promise<unknown>

/** Ack after this many bytes applied since the last ack (or when the queue is empty). */
export const ACK_EVERY_BYTES = 64 * 1024

/** Full reset (RIS): part of a snapshot's write, so no frame shows an empty screen. */
const FULL_RESET = "\x1bc"

/**
 * What happens to events received but not yet applied when the connection
 * drops: `keep` applies them and resumes after them; `discard` drops them and
 * resumes from the last applied byte. Both end in the same screen.
 */
export type DropPolicy = "keep" | "discard"

export interface TerminalStreamOptions {
  subscribe: SubscribeOutput
  ack: AckOutput
  sessionId: string
  emulator: TerminalEmulator
  dropPolicy: DropPolicy
  /** The emulator changed size (a snapshot or a PTY resize). */
  onSize: (cols: number, rows: number) => void
  onExit: (exitCode: number | null) => void
  /** A server error ended the stream (not a connection drop, which resumes). */
  onError: (message: string) => void
}

/** Decode base64 to bytes without Node's Buffer (browsers and React Native have atob). */
function decodeBase64(base64: string): Uint8Array {
  const text = atob(base64)
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index)
  return bytes
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return bytes
}

/** Wait before subscribing again when a subscription could not be sent. */
export const RESUBSCRIBE_RETRY_MS = 250

/** How a stream starts (counted for tests and logs). */
export type StartMode = "replay" | "snapshot"

/** A random id per subscription (no `crypto.randomUUID` in React Native's Hermes). */
function newStreamId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

/**
 * Where a terminal shown again resumes: its consumed point, so the daemon
 * replays when its tail still has the bytes and sends a snapshot otherwise
 * (user decision, 2026-11-18; the other choice was always a snapshot: null).
 */
function resumePointWhenShown(consumed: ResumePoint | null): ResumePoint | null {
  return consumed
}

export class TerminalStream {
  readonly #options: TerminalStreamOptions
  /** Events received from the current or an ended subscription, not yet applied. */
  #queue: TerminalOutput[] = []
  #writing = false
  #consumed: ResumePoint | null = null
  #subscription: { unsubscribe: () => void } | null = null
  /** Bumped per subscription, so events of an ended one are ignored. */
  #epoch = 0
  #resubscribeWhenIdle = false
  #closed = false
  #visible = true
  #holdSkip = false
  /** The current subscription's stream id; null while none is open. */
  #streamId: string | null = null
  /** Applied since the last ack: bytes, and events of any kind. */
  #bytesSinceAck = 0
  #eventsSinceAck = 0
  /** The emulator's size as this stream last set it. */
  #size: { cols: number; rows: number } | null = null
  /** The start mode of each subscription, oldest first. */
  readonly starts: StartMode[] = []

  constructor(options: TerminalStreamOptions) {
    this.#options = options
  }

  /** Subscribe for the first time: a fresh emulator asks for a snapshot. */
  open(): void {
    this.#subscribe(null)
  }

  /** Events received and not yet handed to the emulator. */
  queued(): number {
    return this.#queue.length
  }

  /** The emulator's resume point, or null before the first start was applied. */
  consumed(): ResumePoint | null {
    return this.#consumed
  }

  /**
   * End the subscription and subscribe again from the consumed point, as after
   * a lost connection (also used when the server says the stream is behind).
   * A hidden terminal only ends it.
   */
  resume(): void {
    if (this.#closed) return
    this.#endSubscription()
    if (this.#options.dropPolicy === "discard") this.#queue = []
    this.#resubscribeWhenIdle = this.#visible
    this.#pump()
  }

  /**
   * Hidden: end the subscription (the server sends nothing), keep the
   * emulator and the consumed point. Shown: subscribe again from there.
   */
  setVisible(visible: boolean): void {
    if (this.#closed || visible === this.#visible) return
    this.#visible = visible
    if (!visible) {
      this.#endSubscription()
      this.#resubscribeWhenIdle = false
      return
    }
    this.#resubscribeWhenIdle = true
    this.#pump()
  }

  /**
   * While true (the user has a selection, or has scrolled up), the server
   * holds a skip instead of replacing the view; it applies once this is false.
   */
  setHoldSkip(hold: boolean): void {
    if (this.#closed || hold === this.#holdSkip) return
    this.#holdSkip = hold
    this.#sendAck()
  }

  close(): void {
    this.#closed = true
    this.#endSubscription()
    this.#queue = []
  }

  #endSubscription(): void {
    this.#epoch += 1
    this.#subscription?.unsubscribe()
    this.#subscription = null
    this.#streamId = null
  }

  #subscribe(resume: ResumePoint | null): void {
    if (!this.#visible) return
    const epoch = ++this.#epoch
    let sawOpen = false
    const streamId = newStreamId()
    this.#streamId = streamId
    this.#bytesSinceAck = 0
    this.#eventsSinceAck = 0
    this.#subscription = this.#options.subscribe(
      { sessionId: this.#options.sessionId, resume, streamId, holdSkip: this.#holdSkip },
      {
        onData: ({ data }) => {
          if (epoch !== this.#epoch) return
          if (data.type === "behind") {
            this.resume()
            return
          }
          this.#queue.push(data)
          this.#pump()
        },
        onError: (error) => {
          if (epoch !== this.#epoch) return
          // A subscription sent while tRPC is still reconnecting fails without
          // reaching the server; try again shortly.
          if (error.data === undefined || error.data === null) {
            this.#endSubscription()
            setTimeout(() => this.resume(), RESUBSCRIBE_RETRY_MS)
            return
          }
          this.#options.onError(error.message)
        },
        onConnectionStateChange: (state) => {
          if (epoch !== this.#epoch) return
          if (state.state === "pending") sawOpen = true
          // The socket this subscription was sent on closed; tRPC is reconnecting.
          else if (state.state === "connecting" && state.error !== null && sawOpen) this.resume()
        },
      },
    )
  }

  /** Apply queued events one write at a time, in order; then resubscribe if asked. */
  #pump(): void {
    if (this.#writing || this.#closed) return
    const event = this.#queue.shift()
    if (event === undefined) {
      if (this.#eventsSinceAck > 0) this.#sendAck()
      if (this.#resubscribeWhenIdle) {
        this.#resubscribeWhenIdle = false
        this.#subscribe(resumePointWhenShown(this.#consumed))
      }
      return
    }
    const { emulator } = this.#options
    switch (event.type) {
      case "start": {
        this.starts.push(event.mode)
        if (event.mode === "snapshot") {
          // The reset is the first byte of the write, so no frame shows an empty screen.
          this.#resize(event.cols, event.rows)
          emulator.write(FULL_RESET + event.screen, () => {})
        } else if (
          this.#consumed === null ||
          event.generation !== this.#consumed.generation ||
          event.offset !== this.#consumed.offset
        ) {
          this.#mismatch(`replay from ${event.offset} does not continue the screen`)
          return
        }
        const end = { generation: event.generation, offset: 0, revision: event.revision }
        this.#write(decodeBase64(event.base64), event.offset, end)
        return
      }
      case "data": {
        const consumed = this.#consumed
        if (consumed === null || event.offset !== consumed.offset) {
          this.#mismatch(`output at ${event.offset} does not continue the screen`)
          return
        }
        // Join consecutive chunks into one write, so a flood costs few emulator ticks.
        const chunks = [decodeBase64(event.base64)]
        while (this.#queue[0]?.type === "data") {
          const next = this.#queue.shift() as Extract<TerminalOutput, { type: "data" }>
          chunks.push(decodeBase64(next.base64))
        }
        this.#write(concatBytes(chunks), event.offset, consumed)
        return
      }
      case "resize": {
        this.#resize(event.cols, event.rows)
        if (this.#consumed !== null)
          this.#consumed = { ...this.#consumed, revision: event.revision }
        this.#eventsSinceAck += 1
        this.#pump()
        return
      }
      case "exit":
        // The program ended: nothing more to resume.
        this.#closed = true
        this.#endSubscription()
        this.#options.onExit(event.exitCode)
        return
      case "behind":
        return
    }
  }

  /** Resize the emulator when the size differs from the last one set. */
  #resize(cols: number, rows: number): void {
    if (this.#size?.cols === cols && this.#size.rows === rows) return
    this.#size = { cols, rows }
    this.#options.emulator.resize(cols, rows)
    this.#options.onSize(cols, rows)
  }

  /** Write bytes that start at `offset`; once applied, the consumed point moves past them. */
  #write(bytes: Uint8Array, offset: number, point: ResumePoint): void {
    this.#writing = true
    this.#options.emulator.write(bytes, () => {
      this.#writing = false
      if (this.#closed) return
      this.#consumed = { ...point, offset: offset + bytes.length }
      this.#bytesSinceAck += bytes.length
      this.#eventsSinceAck += 1
      if (this.#bytesSinceAck >= ACK_EVERY_BYTES) this.#sendAck()
      this.#pump()
    })
  }

  /**
   * Tell the server what the emulator applied on the current subscription. A
   * lost ack (the socket closed) is not an error: the stream resubscribes with
   * a new id and full credit. A server error is logged.
   */
  #sendAck(): void {
    const streamId = this.#streamId
    if (streamId === null) return
    this.#bytesSinceAck = 0
    this.#eventsSinceAck = 0
    const input = { streamId, offset: this.#consumed?.offset ?? 0, holdSkip: this.#holdSkip }
    this.#options.ack(input).catch((error: { message?: string; data?: unknown }) => {
      if (error.data === undefined || error.data === null) return
      console.error(`[pi-lab] terminal ${this.#options.sessionId}: ack failed: ${error.message}`)
    })
  }

  /**
   * An event that does not start at the consumed offset means a gap or a
   * duplicate. Log it and start again from a snapshot, which replaces the screen.
   */
  #mismatch(detail: string): void {
    console.error(`[pi-lab] terminal ${this.#options.sessionId}: ${detail}; asking for a snapshot`)
    this.#endSubscription()
    this.#queue = []
    this.#consumed = null
    this.#resubscribeWhenIdle = true
    this.#pump()
  }
}
