export const CLOSE_TAB_REQUEST_CHANNEL = "pi-lab:close-tab-request"
export const CLOSE_TAB_RESPONSE_CHANNEL = "pi-lab:close-tab-response"

/** Main asks the focused window whether Cmd+W closes one of its tabs. */
export interface CloseTabRequest {
  requestId: string
}

/** `handled: false` tells main to move the app to the background instead. */
export interface CloseTabResponse {
  requestId: string
  handled: boolean
}

export interface CloseTabBridge {
  subscribe: (listener: (request: CloseTabRequest) => void) => () => void
  respond: (response: CloseTabResponse) => void
}

/** Check the request payload before handing it to renderer listeners. */
export function isCloseTabRequest(value: unknown): value is CloseTabRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0
  )
}

/** Reject untyped IPC responses before checking the sender and pending request. */
export function isCloseTabResponse(value: unknown): value is CloseTabResponse {
  return (
    isCloseTabRequest(value) &&
    "handled" in value &&
    typeof (value as { handled: unknown }).handled === "boolean"
  )
}
