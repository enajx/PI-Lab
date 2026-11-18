import { replyLost } from "../trpc/launch"

/** What `terminal.write` carries for a typed key (see `KeyInput` in @pi-lab/pty-daemon). */
export interface KeyWrite {
  seq: number
  typedAt: { generation: string; offset: number } | null
  firstSend: boolean
}

export type KeyStatus = "applied" | "duplicate" | "dropped"

export interface KeySenderOptions {
  /** `terminal.write` for one key; `signal` aborts a send tRPC still holds. */
  write: (data: string, key: KeyWrite, signal: AbortSignal) => Promise<KeyStatus>
  /** The emulator's consumed point now, or null before the first start. */
  consumed: () => { generation: string; offset: number } | null
  /** The connection state now (renderer/trpc/connectionStatus.ts). */
  connection: () => "connected" | "reconnecting" | "disconnected"
  /** The next number in this client's key sequence. */
  nextSeq: () => number
  /** Some typed input was not sent (dropped by the daemon, or discarded after a long drop). */
  onLost: () => void
  /** A server error (not a lost reply). */
  onError: (error: unknown) => void
  /** A key was written (or had been, for a duplicate). */
  onDelivered: () => void
}

/** Most sends of one key (the first and the resends after lost replies). */
const KEY_ATTEMPTS = 5

/**
 * Sends typed keys so that each reaches the PTY at most once, and only onto
 * the screen the user saw (md/branch-connection-layer.md, "Input after a
 * drop"). Each key carries its sequence number and the consumed point it was
 * typed at. A key whose reply is lost (the WebSocket closed) is sent again
 * with `firstSend: false`; tRPC holds it until the socket is open again. A key
 * typed while reconnecting goes out the same way; one typed once Disconnected
 * shows is not sent. The daemon decides: a
 * duplicate is not written again, a resend is written only if no output
 * appeared since it was typed, otherwise it is dropped. When the connection
 * has been down long enough to show Disconnected (10 s), every key still
 * waiting is discarded ({@link discardWaiting}). Both losses call `onLost`.
 */
export class KeySender {
  readonly #options: KeySenderOptions
  readonly #waiting = new Set<AbortController>()

  constructor(options: KeySenderOptions) {
    this.#options = options
  }

  /** Send one key (or pasted text); returns its sequence number. */
  send(data: string): number {
    const seq = this.#options.nextSeq()
    // Past the short-drop window: not sent at all.
    if (this.#options.connection() === "disconnected") {
      this.#options.onLost()
      return seq
    }
    const typedAt = this.#options.consumed()
    const controller = new AbortController()
    this.#waiting.add(controller)
    const attempt = (number: number, firstSend: boolean): void => {
      this.#options.write(data, { seq, typedAt, firstSend }, controller.signal).then(
        (status) => {
          this.#waiting.delete(controller)
          if (status === "dropped") this.#options.onLost()
          else this.#options.onDelivered()
        },
        (error: unknown) => {
          if (controller.signal.aborted) return
          if (replyLost(error) && number < KEY_ATTEMPTS) {
            attempt(number + 1, false)
            return
          }
          this.#waiting.delete(controller)
          if (replyLost(error)) this.#options.onLost()
          else this.#options.onError(error)
        },
      )
    }
    attempt(1, this.#options.connection() === "connected")
    return seq
  }

  /** Keys sent but not answered yet. */
  waiting(): number {
    return this.#waiting.size
  }

  /** The drop lasted too long: give up on every key still waiting. */
  discardWaiting(): void {
    if (this.#waiting.size === 0) return
    for (const controller of this.#waiting) controller.abort()
    this.#waiting.clear()
    this.#options.onLost()
  }
}
