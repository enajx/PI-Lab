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
  reset: () => void
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
  input: { sessionId: string; resume: ResumePoint | null },
  handlers: OutputSubscriptionHandlers,
) => { unsubscribe: () => void }

/**
 * What happens to events received but not yet applied when the connection
 * drops: `keep` applies them and resumes after them; `discard` drops them and
 * resumes from the last applied byte. Both end in the same screen.
 */
export type DropPolicy = "keep" | "discard"

export interface TerminalStreamOptions {
  subscribe: SubscribeOutput
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
   */
  resume(): void {
    if (this.#closed) return
    this.#endSubscription()
    if (this.#options.dropPolicy === "discard") this.#queue = []
    this.#resubscribeWhenIdle = true
    this.#pump()
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
  }

  #subscribe(resume: ResumePoint | null): void {
    const epoch = ++this.#epoch
    let sawOpen = false
    this.#subscription = this.#options.subscribe(
      { sessionId: this.#options.sessionId, resume },
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
      if (this.#resubscribeWhenIdle) {
        this.#resubscribeWhenIdle = false
        this.#subscribe(this.#consumed)
      }
      return
    }
    const { emulator } = this.#options
    switch (event.type) {
      case "start": {
        this.starts.push(event.mode)
        if (event.mode === "snapshot") {
          emulator.reset()
          emulator.resize(event.cols, event.rows)
          this.#options.onSize(event.cols, event.rows)
          emulator.write(event.screen, () => {})
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
        emulator.resize(event.cols, event.rows)
        this.#options.onSize(event.cols, event.rows)
        if (this.#consumed !== null)
          this.#consumed = { ...this.#consumed, revision: event.revision }
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

  /** Write bytes that start at `offset`; once applied, the consumed point moves past them. */
  #write(bytes: Uint8Array, offset: number, point: ResumePoint): void {
    this.#writing = true
    this.#options.emulator.write(bytes, () => {
      this.#writing = false
      if (this.#closed) return
      this.#consumed = { ...point, offset: offset + bytes.length }
      this.#pump()
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
