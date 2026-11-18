import { expect } from "./playwright"
import { connectServer, processAlive, readServerDiscovery } from "./serverClient"

/**
 * Stop the PI Lab server running on `dataDir`, with its agents and terminals,
 * and wait until its process is gone. Does nothing when no server runs there.
 * Specs that launch with `PI_LAB_TEST_RETAIN_SERVER=1` call this to clean up.
 */
export async function stopServerIn(dataDir: string): Promise<void> {
  const discovery = readServerDiscovery(dataDir)
  if (!discovery || !processAlive(discovery.pid)) return
  const { client, close } = connectServer(dataDir)
  await client.server.stop.mutate({ stopAgents: true }).catch(() => undefined)
  close()
  await expect.poll(() => processAlive(discovery.pid), { timeout: 15_000 }).toBe(false)
}
