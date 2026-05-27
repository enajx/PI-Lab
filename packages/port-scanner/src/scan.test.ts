import net from "node:net"
import { afterEach, describe, expect, test } from "vitest"
import type { PortRange } from "./allocation"
import { firstFreePortInRange, isPortInUse } from "./scan"

const HOST = "127.0.0.1"

// Track every server we open so a failed assertion still releases the port.
const openServers = new Set<net.Server>()

/** Bind a throwaway listener on an OS-chosen ephemeral port; resolve its port. */
function listenOnEphemeralPort(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, HOST, () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("expected a TCP address from the listening server"))
        return
      }
      openServers.add(server)
      resolve({ server, port: address.port })
    })
  })
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!openServers.has(server)) {
      resolve()
      return
    }
    openServers.delete(server)
    server.close(() => resolve())
  })
}

afterEach(async () => {
  await Promise.all([...openServers].map((server) => closeServer(server)))
})

describe("isPortInUse", () => {
  test("reports true for a port with an active listener", async () => {
    const { port } = await listenOnEphemeralPort()
    await expect(isPortInUse(port, HOST)).resolves.toBe(true)
  })

  test("reports false once the listener closes", async () => {
    const { server, port } = await listenOnEphemeralPort()
    await expect(isPortInUse(port, HOST)).resolves.toBe(true)
    await closeServer(server)
    await expect(isPortInUse(port, HOST)).resolves.toBe(false)
  })

  test("defaults to the loopback host", async () => {
    const { port } = await listenOnEphemeralPort()
    await expect(isPortInUse(port)).resolves.toBe(true)
  })
})

describe("firstFreePortInRange", () => {
  test("returns a free port that lies within the range", async () => {
    // Probe a small range around a freshly closed ephemeral port: at least one
    // member is guaranteed free, and the result must be inside the range.
    const { server, port } = await listenOnEphemeralPort()
    await closeServer(server)
    const range: PortRange = { start: port, end: port + 4 }

    const free = await firstFreePortInRange(range, HOST)
    expect(free).toBeDefined()
    expect(free).toBeGreaterThanOrEqual(range.start)
    expect(free).toBeLessThanOrEqual(range.end)
    if (free !== undefined) {
      await expect(isPortInUse(free, HOST)).resolves.toBe(false)
    }
  })

  test("skips the occupied port at the start of a range", async () => {
    const { port } = await listenOnEphemeralPort()
    const range: PortRange = { start: port, end: port + 3 }

    const free = await firstFreePortInRange(range, HOST)
    expect(free).toBeDefined()
    expect(free).not.toBe(port)
    expect(free).toBeGreaterThan(port)
    expect(free).toBeLessThanOrEqual(range.end)
  })
})
