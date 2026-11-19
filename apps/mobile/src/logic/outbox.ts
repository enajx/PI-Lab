/** Sends one session message with `terminal.sendMessage`. */
export type SendMessage = (input: { messageId: string; text: string }) => Promise<void>

/**
 * The reply box's sending: a message keeps its message ID until it was sent,
 * so sending it again after a failed or lost reply uses the same ID and the
 * server writes it once. A different text gets a new ID.
 */
export class MessageOutbox {
  readonly #newId: () => string
  #unsent: { messageId: string; text: string } | null = null

  constructor(newId: () => string) {
    this.#newId = newId
  }

  async send(text: string, send: SendMessage): Promise<void> {
    if (this.#unsent?.text !== text) this.#unsent = { messageId: this.#newId(), text }
    const message = this.#unsent
    await send(message)
    if (this.#unsent === message) this.#unsent = null
  }
}
