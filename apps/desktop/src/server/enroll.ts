import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { resolveDataDir } from "@pi-lab/local-db/paths"
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client"
import { WebSocket } from "ws"
import type { ServerRouter } from "../main/trpc/serverRouter"
import { proveServerIdentity, readDiscovery, TOKEN_FILE } from "./access"

/** How long enroll waits for the server's answers. */
const CALL_TIMEOUT_MS = 10_000

/** What `pi-lab-server enroll` prints: the token appears only here. */
export interface EnrollResult {
  machineId: string
  deviceId: string
  token: string
}

/**
 * `pi-lab-server enroll --name <client name>`, run on the server machine
 * (usually over SSH by the client being added). Asks the running server, as
 * the local device, for a new device and prints `{ machineId, deviceId, token }`
 * as one JSON line on stdout. The data folder is `PI_LAB_DATA_DIR` or the
 * default (`resolveDataDir()`), as for the server.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { name: { type: "string" } },
    strict: true,
  })
  const name = values.name?.trim()
  if (!name) throw new Error("Usage: pi-lab-server enroll --name <client name>")

  const dataDir = resolveDataDir()
  const discovery = readDiscovery(dataDir)
  if (!discovery) throw new Error(`No PI Lab server runs for ${dataDir} (no server.json)`)
  const localToken = readFileSync(join(dataDir, TOKEN_FILE), "utf8").trim()
  if (!(await proveServerIdentity(discovery.port, localToken))) {
    throw new Error(`No PI Lab server runs for ${dataDir} (port ${discovery.port} does not answer)`)
  }

  const socket = createWSClient({
    url: `ws://127.0.0.1:${discovery.port}/trpc?token=${encodeURIComponent(localToken)}`,
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
  })
  const client = createTRPCClient<ServerRouter>({ links: [wsLink({ client: socket })] })
  const signal = AbortSignal.timeout(CALL_TIMEOUT_MS)
  const hello = await client.server.hello.query(undefined, { signal })
  const created = await client.server.devices.create.mutate({ name }, { signal })
  socket.close()
  const result: EnrollResult = {
    machineId: hello.machineId,
    deviceId: created.device.id,
    token: created.token,
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`pi-lab-server enroll: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
