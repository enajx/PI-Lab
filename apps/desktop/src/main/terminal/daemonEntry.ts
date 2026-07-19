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
 */

import { resolveSocketPath, startDaemon } from "@pi-lab/pty-daemon"

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

main().catch((error) => {
  process.stderr.write(`pty-daemon failed to start: ${String(error)}\n`)
  process.exit(1)
})
