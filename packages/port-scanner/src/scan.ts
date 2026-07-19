// Localhost port-availability checks. These touch the network stack, so they
// live apart from the pure allocation math and are covered by example/integration
// tests rather than property tests (md/engineering/testing-and-build.md). Every socket and server
// opened here is closed before the promise settles — no leaked handles.

import net from "node:net"
import type { PortRange } from "./allocation"

const DEFAULT_HOST = "127.0.0.1"

/** How long to wait for a connection attempt before treating the port as free. */
const CONNECT_TIMEOUT_MS = 250

/**
 * Resolve to `true` when something is already listening on `port` at `host`.
 *
 * Works by attempting an outbound TCP connection: a successful connect means a
 * listener accepted us (in use); `ECONNREFUSED` means nobody is there (free).
 * A timeout (e.g. a firewalled/filtered port) is treated as "in use" — the
 * conservative answer when allocating ports, since we'd rather skip an
 * ambiguous port than hand out one that turns out to be taken.
 */
export function isPortInUse(port: number, host: string = DEFAULT_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false

    const finish = (inUse: boolean) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(inUse)
    }

    socket.setTimeout(CONNECT_TIMEOUT_MS)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(true))
    socket.once("error", (error: NodeJS.ErrnoException) => {
      // Refused means the port is free; anything else is ambiguous → treat as taken.
      finish(error.code !== "ECONNREFUSED")
    })

    socket.connect(port, host)
  })
}

/**
 * Resolve to the first port in `range` (inclusive, ascending) that nothing is
 * listening on, or `undefined` when every port in the range is occupied.
 * Ports are probed in order and the search stops at the first free one.
 */
export async function firstFreePortInRange(
  range: PortRange,
  host: string = DEFAULT_HOST,
): Promise<number | undefined> {
  for (let port = range.start; port <= range.end; port++) {
    if (!(await isPortInUse(port, host))) {
      return port
    }
  }
  return undefined
}
