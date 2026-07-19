// Standalone entry point: run the PTY daemon as its own process so terminals
// and agent sessions survive an Electron reload or restart. The Electron main
// process spawns this as a child (passing PI_LAB_SOCKET_PATH), and tests run
// it the same way against a temp socket.
//
//   PI_LAB_SOCKET_PATH=/tmp/pi-lab.sock bun packages/pty-daemon/src/serve.ts
//   node packages/pty-daemon/src/serve.ts /tmp/pi-lab.sock   (explicit arg wins)

import { DaemonServer, resolveSocketPath } from "./server"

export async function startDaemon(socketPath: string): Promise<DaemonServer> {
  const server = new DaemonServer({ socketPath })
  await server.listen()
  return server
}

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

// Run only when invoked directly, not when imported (e.g. by tests).
const invokedPath = process.argv[1] ?? ""
if (invokedPath.endsWith("serve.ts") || invokedPath.endsWith("serve.js")) {
  main().catch((error) => {
    process.stderr.write(`pty-daemon failed to start: ${String(error)}\n`)
    process.exit(1)
  })
}
