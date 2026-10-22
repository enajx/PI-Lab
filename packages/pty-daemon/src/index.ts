// Public surface of @pi-lab/pty-daemon. The server internals (SessionStore,
// Connection) are intentionally not exported; consumers use the client to talk
// to a daemon, the protocol types to type their own frames, and `startDaemon`
// to supervise one in-process when needed.

export {
  type AttachResult,
  DaemonClient,
  type DaemonClientEvents,
  DaemonError,
  type SpawnParams,
} from "./client"
export {
  type AttachReply,
  type AttachRequest,
  type ClientRequest,
  type DaemonEvent,
  type DaemonFrame,
  type DaemonReply,
  type DataEvent,
  type ErrorReply,
  type ExitEvent,
  type KillRequest,
  type ListReply,
  type ListRequest,
  PROTOCOL_VERSION,
  type ProcessEvent,
  type ProcessExitEvent,
  type ProcessOutputEvent,
  type ProcessParams,
  type ProcessResult,
  type ProcessSnapshot,
  type ProcessSummary,
  type ResizeRequest,
  type SessionInfo,
  type SpawnReply,
  type SpawnRequest,
  type WriteRequest,
} from "./protocol"
export { startDaemon } from "./serve"
export { DaemonServer, type DaemonServerOptions, resolveSocketPath } from "./server"
