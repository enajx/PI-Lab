// Tests for the daemon supervisor that DON'T spawn a detached child (that path
// is exercised by the app/verify harness). We cover the pure spawn plan, the
// liveness probe, and the *adopt* branch against an in-process DaemonServer.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonServer } from "@skipper/pty-daemon"
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
  socketDir = await mkdtemp(join(tmpdir(), "skipper-supervisor-"))
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
    expect(plan.env.SKIPPER_SOCKET_PATH).toBe("/tmp/sock")
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

  test("ensureClient rejects after dispose", async () => {
    server = new DaemonServer({ socketPath })
    await server.listen()
    supervisor = new TerminalSupervisor({ socketPath })
    await supervisor.ensureClient()
    supervisor.dispose()
    await expect(supervisor.ensureClient()).rejects.toThrow(/disposed/)
  })
})
