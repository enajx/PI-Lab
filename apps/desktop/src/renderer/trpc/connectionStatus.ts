import { useSyncExternalStore } from "react"

/** What the status bar shows for the server sockets. */
export type ConnectionState = "connected" | "reconnecting" | "disconnected"

/**
 * Provisional (set after the flood test): a socket that stays down this long
 * shows Disconnected instead of Reconnecting. tRPC keeps retrying either way.
 */
export const DISCONNECTED_AFTER_MS = 10_000

/**
 * The state of this client's server sockets (calls and terminal output),
 * driven by the WebSocket clients' open and close events. The worst socket
 * wins: any socket down means Reconnecting, and Disconnected once one has been
 * down for {@link DISCONNECTED_AFTER_MS}. A socket that is still making its
 * first connection does not count as down (the terminal socket is created
 * lazily, when the first terminal opens); a socket counts as down once it
 * closes, whether it was open or its first connection failed.
 */
export class ConnectionStatus {
  readonly #downSince = new Map<string, number | null>()
  readonly #listeners = new Set<() => void>()
  readonly #reopenListeners = new Set<(name: string) => void>()
  readonly #opened = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | null = null
  #state: ConnectionState = "connected"

  /** A socket was created and is making its first connection. */
  socketCreated(name: string): void {
    this.#downSince.set(name, null)
    this.#update()
  }

  socketOpened(name: string): void {
    const wasDown = this.#downSince.get(name) != null
    const openedBefore = this.#opened.has(name)
    this.#opened.add(name)
    this.#downSince.set(name, null)
    this.#update()
    if (wasDown && openedBefore) for (const listener of this.#reopenListeners) listener(name)
  }

  socketClosed(name: string): void {
    if (this.#downSince.get(name) == null) this.#downSince.set(name, Date.now())
    this.#update()
  }

  state(): ConnectionState {
    return this.#state
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Call `listener` with the socket's name each time a socket opens again after
   * it closed. The server may have restarted, and calls that were in flight when
   * the socket closed failed, so readers refetch here.
   */
  onReopened(listener: (name: string) => void): () => void {
    this.#reopenListeners.add(listener)
    return () => this.#reopenListeners.delete(listener)
  }

  #update(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    const downs = [...this.#downSince.values()].filter((since): since is number => since !== null)
    let next: ConnectionState = "connected"
    if (downs.length > 0) {
      const longest = Date.now() - Math.min(...downs)
      if (longest >= DISCONNECTED_AFTER_MS) next = "disconnected"
      else {
        next = "reconnecting"
        this.#timer = setTimeout(() => this.#update(), DISCONNECTED_AFTER_MS - longest)
      }
    }
    if (next === this.#state) return
    this.#state = next
    for (const listener of this.#listeners) listener()
  }
}

/** The status of this document's server sockets (see `client.ts`). */
export const connectionStatus = new ConnectionStatus()

/** React view of {@link connectionStatus}. */
export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(
    (listener) => connectionStatus.subscribe(listener),
    () => connectionStatus.state(),
  )
}
