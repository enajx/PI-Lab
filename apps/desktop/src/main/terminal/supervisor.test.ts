// Tests for the daemon supervisor that DON'T spawn a detached child (that path
// is exercised by the app/verify harness). We cover the pure spawn plan, the
// liveness probe, and the *adopt* branch against an in-process DaemonServer.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonServer } from "@pi-lab/pty-daemon"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  isDaemonListening,
  planDaemonSpawn,
  resolveDaemonEntry,
  TerminalSupervisor,
} from "./supervisor"

let socketDir: string
let socketPath: string
let server: DaemonServer | null = null
let supervisor: TerminalSupervisor | null = null

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "pi-lab-supervisor-"))
  socketPath = join(socketDir, "daemon.sock")
})

afterEach(async () => {
  supervisor?.dispose()
  supervisor = null
  if (server) {
    await server.close()
    server = null
  }
  await rm(socketDir, { recursive: true, force: true })
})

describe("planDaemonSpawn", () => {
  test("runs the bundle under the current executable in Node mode, socket via argv + env", () => {
    const plan = planDaemonSpawn("/abs/out/pty-daemon/index.js", "/tmp/sock")
    expect(plan.command).toBe(process.execPath)
    expect(plan.args).toEqual(["/abs/out/pty-daemon/index.js", "/tmp/sock"])
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBe("1")
    expect(plan.env.PI_LAB_SOCKET_PATH).toBe("/tmp/sock")
  })
})

describe("resolveDaemonEntry", () => {
  test("points at the pty-daemon bundle beside the main bundle", () => {
    expect(resolveDaemonEntry().endsWith(join("pty-daemon", "index.js"))).toBe(true)
  })
})

describe("isDaemonListening", () => {
  test("false when nothing is bound", async () => {
    expect(await isDaemonListening(socketPath)).toBe(false)
  })

  test("true once a daemon is listening", async () => {
    server = new DaemonServer({ socketPath })
    await server.listen()
    expect(await isDaemonListening(socketPath)).toBe(true)
  })
})

describe("adopt branch", () => {
  test.each([
    "primary",
    "monitor",
  ] as const)("dispose rejects an in-flight %s start without a late connection", async (kind) => {
    server = new DaemonServer({ socketPath })
    await server.listen()
    supervisor = new TerminalSupervisor({ socketPath })
    if (kind === "monitor") await supervisor.ensureClient()
    const starting =
      kind === "primary" ? supervisor.ensureClient() : supervisor.ensureMonitorClient()
    supervisor.dispose()
    await expect(starting).rejects.toThrow("supervisor disposed")
    const deadline = Date.now() + 1_000
    while ((server as unknown as { connections: Set<unknown> }).connections.size > 0) {
      if (Date.now() >= deadline)
        throw new Error("disposed supervisor retained a daemon connection")
      await new Promise((done) => setTimeout(done, 10))
    }
  })

  test("ensureClient adopts an already-listening daemon and shares one client", async () => {
    server = new DaemonServer({ socketPath })
    await server.listen()

    supervisor = new TerminalSupervisor({ socketPath })
    const a = await supervisor.ensureClient()
    const b = await supervisor.ensureClient()
    expect(a).toBe(b)

    // Round-trip through the adopted daemon to prove the client is live.
    const sessions = await a.list()
    expect(Array.isArray(sessions)).toBe(true)
  })

  test("keeps lifecycle monitoring on a distinct connection after renderer detach", async () => {
    server = new DaemonServer({ socketPath })
    await server.listen()

    supervisor = new TerminalSupervisor({ socketPath })
    const rendererClient = await supervisor.ensureClient()
    const monitorClient = await supervisor.ensureMonitorClient()
    expect(monitorClient).not.toBe(rendererClient)

    const session = await rendererClient.spawn({ command: "/bin/cat", args: [] })
    await monitorClient.attach(session.id)
    await rendererClient.detach(session.id)

    const observed = new Promise<string>((resolve) => {
      monitorClient.on("data", (event) => {
        if (event.sessionId === session.id && event.chunk.includes("monitor-alive")) {
          resolve(event.chunk)
        }
      })
    })
    await rendererClient.write(session.id, "monitor-alive\n")

    await expect(observed).resolves.toContain("monitor-alive")
    await rendererClient.kill(session.id)
  })

  test("ensureClient rejects after dispose", async () => {
    server = new DaemonServer({ socketPath })
    await server.listen()
    supervisor = new TerminalSupervisor({ socketPath })
    await supervisor.ensureClient()
    supervisor.dispose()
    await expect(supervisor.ensureClient()).rejects.toThrow(/disposed/)
    await expect(supervisor.ensureMonitorClient()).rejects.toThrow(/disposed/)
  })
})

describe("reapDaemonOnDispose", () => {
  // The spawn+SIGTERM reap itself is exercised end-to-end by the E2E teardown
  // (it is what lets Playwright's app.close() complete on Linux). Here we cover
  // the one branch a unit test can reach: with reaping ON but the daemon
  // *adopted* (no child handle), dispose must be a safe no-op — it must not
  // throw and must still close the client.
  test("dispose is a safe no-op when reaping is on but the daemon was adopted", async () => {
    server = new DaemonServer({ socketPath })
    await server.listen()
    supervisor = new TerminalSupervisor({ socketPath, reapDaemonOnDispose: true })
    await supervisor.ensureClient()

    expect(() => supervisor?.dispose()).not.toThrow()
    await expect(supervisor.ensureClient()).rejects.toThrow(/disposed/)
  })
})
