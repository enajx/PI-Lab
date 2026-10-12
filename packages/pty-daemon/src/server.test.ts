// Integration tests against a real in-process daemon, real PTYs, and a real
// Unix socket. Each test gets an isolated socket under a mkdtemp dir and tears
// the daemon + sessions + socket down in afterEach. Timing is handled by
// polling with a deadline, never fixed sleeps, so the suite stays deterministic.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { DaemonClient } from "./client"
import { DaemonServer } from "./server"

const NODE = process.execPath

let socketDir: string
let socketPath: string
let server: DaemonServer
const clients: DaemonClient[] = []
let reapedIds: string[]
let retainingConnectionsAtReap: number[]

/** Inspect the live connections' subscription maps for retained references. */
function connectionSubscriptions(): Map<string, () => void>[] {
  const connections = (
    server as unknown as {
      connections: Set<{ subscriptions: Map<string, () => void> }>
    }
  ).connections
  return Array.from(connections, (connection) => connection.subscriptions)
}

/** Hold a weak reference to a session without adding a production debug API. */
function weakSession(sessionId: string): WeakRef<object> {
  const sessions = (server as unknown as { store: { sessions: Map<string, object> } }).store
    .sessions
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`missing session ${sessionId}`)
  return new WeakRef(session)
}

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "pi-lab-ptyd-"))
  socketPath = join(socketDir, "daemon.sock")
  reapedIds = []
  retainingConnectionsAtReap = []
  server = new DaemonServer({
    socketPath,
    store: {
      onSessionReaped: (sessionId) => {
        reapedIds.push(sessionId)
        retainingConnectionsAtReap.push(
          connectionSubscriptions().filter((subscriptions) => subscriptions.has(sessionId)).length,
        )
      },
    },
  })
  await server.listen()
})

afterEach(async () => {
  for (const client of clients) client.close()
  clients.length = 0
  await server.close()
  await rm(socketDir, { recursive: true, force: true })
})

/** Connect a fresh client to the test daemon and register it for teardown. */
async function newClient(): Promise<DaemonClient> {
  const client = new DaemonClient(socketPath)
  await client.connect()
  clients.push(client)
  return client
}

/** Poll `predicate` (sync or async) until it returns true or the deadline elapses. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("waitFor timed out")
}

/** Collect a session's data chunks and exit, draining via the async iterator. */
async function drain(
  client: DaemonClient,
  sessionId: string,
): Promise<{ output: string; exitCode: number | null; signal: number | null }> {
  let output = ""
  let exitCode: number | null = null
  let signal: number | null = null
  for await (const event of client.events(sessionId)) {
    if (event.kind === "data") output += event.chunk
    else {
      exitCode = event.exitCode
      signal = event.signal
    }
  }
  return { output, exitCode, signal }
}

describe("spawn + stream + exit", () => {
  test("a trivial command streams its output and exits cleanly", async () => {
    const client = await newClient()
    const session = await client.spawn({
      command: NODE,
      args: ["-e", "process.stdout.write('hello'); process.exit(0)"],
    })
    expect(session.alive).toBe(true)
    expect(session.pid).not.toBeNull()

    const { output, exitCode } = await drain(client, session.id)
    expect(output).toContain("hello")
    expect(exitCode).toBe(0)
  })
})

describe("session reaping", () => {
  test("persistent connections release each reaped session after late attachment", async () => {
    const first = await newClient()
    const second = await newClient()
    const firstExits = new Set<string>()
    const secondExits = new Set<string>()
    first.on("exit", (event) => firstExits.add(event.sessionId))
    second.on("exit", (event) => secondExits.add(event.sessionId))

    for (let cycle = 0; cycle < 2; cycle++) {
      const sessions = await Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          first.spawn({
            command: NODE,
            args: ["-e", `process.stdout.write('FINAL-${cycle}-${index}'); process.exit(0)`],
          }),
        ),
      )
      const ids = sessions.map((session) => session.id)
      await waitFor(() => ids.every((id) => firstExits.has(id)))

      for (const [index, id] of ids.entries()) {
        const attached = await second.attach(id)
        expect(attached.session.alive).toBe(false)
        expect(attached.scrollback).toContain(`FINAL-${cycle}-${index}`)
        await waitFor(() => secondExits.has(id))
      }
      expect(connectionSubscriptions().map((subscriptions) => subscriptions.size)).toEqual([3, 3])

      await waitFor(() => ids.every((id) => reapedIds.includes(id)), 8_000)
      expect(connectionSubscriptions().map((subscriptions) => subscriptions.size)).toEqual([0, 0])
      expect((await first.list()).some((session) => ids.includes(session.id))).toBe(false)
    }
    expect(retainingConnectionsAtReap).toEqual(Array(6).fill(0))
  }, 20_000)

  test.skipIf(typeof globalThis.gc !== "function")(
    "reaped sessions become collectible while connections stay open",
    async () => {
      const first = await newClient()
      const second = await newClient()
      const references: WeakRef<object>[] = []

      for (let cycle = 0; cycle < 2; cycle++) {
        const sessions = await Promise.all(
          Array.from({ length: 3 }, () =>
            first.spawn({ command: NODE, args: ["-e", "process.exit(0)"] }),
          ),
        )
        const ids = sessions.map((session) => session.id)
        references.push(...ids.map(weakSession))
        await Promise.all(ids.map((id) => second.attach(id)))

        await waitFor(() => ids.every((id) => reapedIds.includes(id)), 8_000)
        expect(connectionSubscriptions().map((subscriptions) => subscriptions.size)).toEqual([0, 0])
        await waitFor(() => {
          globalThis.gc?.()
          return references.every((reference) => reference.deref() === undefined)
        })
      }
    },
    20_000,
  )
})

describe("interactive write/echo", () => {
  test("input written to a shell is echoed back", async () => {
    const client = await newClient()
    // `cat` echoes its stdin straight back to stdout in a PTY.
    const session = await client.spawn({ command: "cat", args: [] })

    let output = ""
    client.on("data", (event) => {
      if (event.sessionId === session.id) output += event.chunk
    })

    await client.write(session.id, "ping\n")
    await waitFor(() => output.includes("ping"))
    expect(output).toContain("ping")

    await client.kill(session.id)
  })
})

describe("reattach contract", () => {
  test("a session survives client disconnect and replays scrollback to a new client", async () => {
    // A long-lived process that prints a marker then echoes stdin (cat) so we
    // can prove both scrollback replay AND resumed live streaming after reattach.
    const first = await newClient()
    const session = await first.spawn({ command: "cat", args: [] })

    let firstOutput = ""
    first.on("data", (event) => {
      if (event.sessionId === session.id) firstOutput += event.chunk
    })
    await first.write(session.id, "MARKER-123\n")
    await waitFor(() => firstOutput.includes("MARKER-123"))

    // Drop the first client entirely; the daemon must keep the PTY alive.
    first.close()
    clients.splice(clients.indexOf(first), 1)

    // A brand-new client reattaches and must see the session live + scrollback.
    const second = await newClient()
    const sessions = await second.list()
    expect(sessions.some((s) => s.id === session.id && s.alive)).toBe(true)

    const { session: reattached, scrollback } = await second.attach(session.id)
    expect(reattached.alive).toBe(true)
    expect(scrollback).toContain("MARKER-123")

    // Live streaming resumes too: input written after reattach is echoed back.
    let liveOutput = ""
    second.on("data", (event) => {
      if (event.sessionId === session.id) liveOutput += event.chunk
    })
    await second.write(session.id, "AFTER-REATTACH\n")
    await waitFor(() => liveOutput.includes("AFTER-REATTACH"))
    expect(liveOutput).toContain("AFTER-REATTACH")

    await second.kill(session.id)
  })
})

describe("resize", () => {
  test("resize updates the pty reported size", async () => {
    const client = await newClient()
    // Print the terminal size on demand: write any line, the script reports cols/rows.
    const session = await client.spawn({
      command: NODE,
      args: [
        "-e",
        "process.stdin.on('data', () => { process.stdout.write('SIZE ' + process.stdout.columns + 'x' + process.stdout.rows + '\\n') })",
      ],
      cols: 80,
      rows: 24,
    })

    let output = ""
    client.on("data", (event) => {
      if (event.sessionId === session.id) output += event.chunk
    })

    await client.resize(session.id, 120, 40)
    await client.write(session.id, "\n")
    await waitFor(() => output.includes("SIZE"))
    expect(output).toMatch(/SIZE 120x40/)

    await client.kill(session.id)
  })
})

describe("list", () => {
  test("reflects live sessions and drops killed ones", async () => {
    const client = await newClient()
    const a = await client.spawn({ command: "cat", args: [] })
    const b = await client.spawn({ command: "cat", args: [] })

    let listed = await client.list()
    const ids = listed.map((s) => s.id)
    expect(ids).toContain(a.id)
    expect(ids).toContain(b.id)
    expect(listed.every((s) => s.alive)).toBe(true)

    await client.kill(a.id)
    // After kill the session is reported not-alive, then reaped after the grace period.
    await waitFor(async () => {
      listed = await client.list()
      const found = listed.find((s) => s.id === a.id)
      return found === undefined || found.alive === false
    })
    const found = (await client.list()).find((s) => s.id === a.id)
    expect(found === undefined || found.alive === false).toBe(true)

    await client.kill(b.id)
  })
})

describe("kill", () => {
  test("ends a session and emits an exit event", async () => {
    const client = await newClient()
    const session = await client.spawn({
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
    })

    let exited = false
    client.on("exit", (event) => {
      if (event.sessionId === session.id) exited = true
    })

    await client.kill(session.id)
    await waitFor(() => exited)
    expect(exited).toBe(true)
  })
})

describe("error handling", () => {
  test("attaching to an unknown session yields a DaemonError", async () => {
    const client = await newClient()
    await expect(client.attach("does-not-exist")).rejects.toMatchObject({
      name: "DaemonError",
      code: "unknown-session",
    })
  })
})
