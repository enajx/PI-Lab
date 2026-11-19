/**
 * True when a server error says the session no longer exists: the PTY daemon
 * answers `no session <id>` for an exited or unknown session
 * (packages/pty-daemon/src/server.ts, code "unknown-session").
 */
export function sessionEnded(errorMessage: string, sessionId: string): boolean {
  return errorMessage.trim() === `no session ${sessionId}`
}
