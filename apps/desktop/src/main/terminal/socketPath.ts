import { join } from "node:path"
import { resolveDataDir } from "@skipper/local-db"

/**
 * Where the PTY daemon's Unix socket lives.
 *
 * The override (`SKIPPER_SOCKET_PATH`, docs/testing-and-build.md) is honored first so the
 * smoke harness and parallel tests can each point at a throwaway socket; with
 * no override it is derived from the resolved data dir so the desktop app and a
 * detached daemon left behind by a prior run agree on the same path (the basis
 * of adopt-on-restart).
 */
export function resolveDaemonSocketPath(): string {
  const override = process.env.SKIPPER_SOCKET_PATH?.trim()
  if (override && override.length > 0) return override
  return join(resolveDataDir(), "pty-daemon.sock")
}
