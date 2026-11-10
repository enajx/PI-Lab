import type { CloseTabBridge } from "../../shared/closeTab"

/** Close the active tab (or open its confirmation prompt); false when there is none. */
export type CloseTabHandler = () => boolean

// Mounted views that can close a tab; the most recently mounted one decides.
const handlers: CloseTabHandler[] = []

/** Let a mounted view answer Cmd+W. Returns the matching unregister function. */
export function registerCloseTabHandler(handler: CloseTabHandler): () => void {
  handlers.push(handler)
  return () => {
    const index = handlers.lastIndexOf(handler)
    if (index !== -1) handlers.splice(index, 1)
  }
}

/**
 * Answer main's Cmd+W requests for this window. Every request gets an answer;
 * with "not handled" main does nothing (Cmd+W never hides the app).
 */
export function installCloseTabResponder(bridge: CloseTabBridge): () => void {
  return bridge.subscribe((request) => {
    const handler = handlers.at(-1)
    bridge.respond({ requestId: request.requestId, handled: handler ? handler() : false })
  })
}
