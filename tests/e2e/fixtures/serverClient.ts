import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ServerRouter } from "../../../apps/desktop/src/server/router"

// The tRPC client is a dependency of the desktop app, not the repo root.
const desktopRequire = createRequire(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "apps",
    "desktop",
    "package.json",
  ),
)
const { createTRPCClient, createWSClient, wsLink } = desktopRequire(
  "@trpc/client",
) as typeof import("@trpc/client")

/** What the server writes to `server.json` in its data folder. */
export interface ServerDiscovery {
  port: number
  pid: number
  build: string
}

/** Read the running server's discovery file, or null when it has not written one. */
export function readServerDiscovery(dataDir: string): ServerDiscovery | null {
  try {
    return JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8")) as ServerDiscovery
  } catch {
    return null
  }
}

/** True while a process with this pid exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A test client of the PI Lab server, connected like any device: over the
 * loopback WebSocket with the local token from the data folder.
 */
export function connectServer(dataDir: string, token?: string) {
  const discovery = readServerDiscovery(dataDir)
  if (!discovery) throw new Error(`No server.json in ${dataDir}`)
  const deviceToken = token ?? readFileSync(join(dataDir, "server-token"), "utf8").trim()
  const ws = createWSClient({
    url: `ws://127.0.0.1:${discovery.port}/trpc?token=${encodeURIComponent(deviceToken)}`,
  })
  const client = createTRPCClient<ServerRouter>({
    links: [wsLink({ client: ws })],
  })
  return { client, close: () => ws.close(), discovery }
}
