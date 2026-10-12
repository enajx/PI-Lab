export const SHUTDOWN_REQUEST_CHANNEL = "pi-lab:shutdown-request"
export const SHUTDOWN_RESPONSE_CHANNEL = "pi-lab:shutdown-response"

export interface ShutdownRequest {
  requestId: string
  intent: "quit" | "close"
}

export interface ShutdownResponse {
  requestId: string
  allow: boolean
}

export interface ShutdownBridge {
  subscribe: (listener: (request: ShutdownRequest) => void) => () => void
  respond: (response: ShutdownResponse) => void
}

/** Check the small request payload before handing it to renderer listeners. */
export function isShutdownRequest(value: unknown): value is ShutdownRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    "intent" in value &&
    (value.intent === "quit" || value.intent === "close")
  )
}

/** Reject untyped IPC responses before checking the sender and pending request. */
export function isShutdownResponse(value: unknown): value is ShutdownResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    "allow" in value &&
    typeof value.allow === "boolean"
  )
}
