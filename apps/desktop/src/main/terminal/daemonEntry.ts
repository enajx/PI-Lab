/**
 * Bundle entry for the detached PTY daemon child (electron.vite.config.ts emits
 * this to `out/pty-daemon/index.js`).
 *
 * We don't bundle `@pi-lab/pty-daemon`'s own `serve.ts` directly: its run guard
 * keys on the filename ending in `serve.{ts,js}`, which our bundle (`index.js`)
 * would never match, so `main()` would silently not run. Instead we drive the
 * reused server primitives here — the daemon logic itself (sockets, sessions,
 * scrollback, reattach) still lives entirely in the package.
 *
 * The supervisor launches this under Electron's bundled Node
 * (`ELECTRON_RUN_AS_NODE=1`), passing the socket path as argv[1] and via
 * `PI_LAB_SOCKET_PATH`; `resolveSocketPath` prefers the explicit arg.
 *
 * With `ALPHA_RESET_PROBE_FLAG` and a socket path, it instead checks an existing
 * daemon for live terminals or jobs and exits 1 with the refusal on stderr; the
 * Alpha build reset runs this synchronously before Electron is ready.
 */

import { resolveSocketPath, startDaemon } from "@pi-lab/pty-daemon"
import { ALPHA_RESET_PROBE_FLAG, assertAlphaResetDaemonIdle } from "./alphaResetGuard"

async function main(): Promise<void> {
  const socketPath = resolveSocketPath(process.argv[2])
  const server = await startDaemon(socketPath)
  process.stdout.write(`pty-daemon listening on ${socketPath}\n`)

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    await server.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

if (process.argv[2] === ALPHA_RESET_PROBE_FLAG) {
  const socketPath = process.argv[3]
  if (!socketPath) throw new Error("Alpha reset probe needs a socket path")
  assertAlphaResetDaemonIdle(socketPath).then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
} else {
  main().catch((error) => {
    process.stderr.write(`pty-daemon failed to start: ${String(error)}\n`)
    process.exit(1)
  })
}
