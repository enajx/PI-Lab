// Tests for the daemon supervisor that DON'T spawn a detached child (that path
// is exercised by the app/verify harness). We cover the pure spawn plan, the
// liveness probe, and the *adopt* branch against an in-process DaemonServer.

import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonServer } from "@pi-lab/pty-daemon"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  daemonPidsFromProcessList,
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

describe("explicit Quit", () => {
  test("lists no sessions and starts no daemon when none is listening", async () => {
    supervisor = new TerminalSupervisor({ socketPath, daemonEntry: join(socketDir, "missing.js") })
    expect(await supervisor.listSessionsIfRunning()).toEqual([])
    expect(await isDaemonListening(socketPath)).toBe(false)
  })

  test("lists the sessions of a listening daemon", async () => {
    server = new DaemonServer({ socketPath })
    await server.listen()
    supervisor = new TerminalSupervisor({ socketPath })
    const shell = await (await supervisor.ensureClient()).spawn({ command: "/bin/cat", args: [] })
    expect((await supervisor.listSessionsIfRunning()).map((session) => session.id)).toEqual([
      shell.id,
    ])
  })

  test("shutdownDaemon stops the daemon's sessions and does not reconnect", async () => {
    const daemon = new DaemonServer({ socketPath })
    server = daemon
    await daemon.listen()
    supervisor = new TerminalSupervisor({
      socketPath,
      daemonEntry: join(socketDir, "missing.js"),
      reconnectBaseMs: 5,
    })
    const shell = await (await supervisor.ensureClient()).spawn({ command: "/bin/cat", args: [] })
    const warn = vi.fn()
    await supervisor.shutdownDaemon(2_000, warn)
    expect(warn).not.toHaveBeenCalled()
    expect(await isDaemonListening(socketPath)).toBe(false)
    expect(() => process.kill(shell.pid as number, 0)).toThrow(/ESRCH/)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(supervisor.ensureClient()).rejects.toThrow(/disposed/)
  })

  test("shutdownDaemon connects to a daemon this app has not used yet", async () => {
    server = new DaemonServer({ socketPath })
    await server.listen()
    supervisor = new TerminalSupervisor({ socketPath })
    const warn = vi.fn()
    await supervisor.shutdownDaemon(2_000, warn)
    expect(warn).not.toHaveBeenCalled()
    expect(await isDaemonListening(socketPath)).toBe(false)
  })

  test("shutdownDaemon warns and returns when the daemon does not confirm in time", async () => {
    // Read and ignore requests, like a daemon built before the shutdown request.
    const silent = createServer((socket) => socket.resume())
    await new Promise<void>((resolve) => silent.listen(socketPath, resolve))
    try {
      supervisor = new TerminalSupervisor({ socketPath })
      const warn = vi.fn()
      const started = Date.now()
      await supervisor.shutdownDaemon(200, warn)
      expect(Date.now() - started).toBeLessThan(1_500)
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0]?.[0]).toMatch(/did not confirm/)
      expect(warn.mock.calls[0]?.[0]).toMatch(/no pty-daemon process owns/)
    } finally {
      await new Promise((resolve) => silent.close(resolve))
    }
  })

  test("shutdownDaemon stops a daemon it is still starting", async () => {
    // A daemon that starts listening only after Quit has begun.
    const entry = join(socketDir, "slow-daemon.js")
    const pidFile = join(socketDir, "slow-daemon.pid")
    await writeFile(
      entry,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setTimeout(() => require('node:net').createServer((s) => s.resume()).listen(process.argv[2]), 300)`,
    )
    supervisor = new TerminalSupervisor({ socketPath, daemonEntry: entry })
    const starting = supervisor.ensureClient().catch(() => undefined)
    const deadline = Date.now() + 5_000
    while (!existsSync(pidFile)) {
      if (Date.now() > deadline) throw new Error("slow daemon did not start")
      await new Promise((done) => setTimeout(done, 10))
    }
    const pid = Number(await readFile(pidFile, "utf8"))
    try {
      await supervisor.shutdownDaemon(2_000, vi.fn())
      await starting
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/)
    } finally {
      spawnSync("kill", ["-9", String(pid)])
    }
  })

  test("an old daemon that ignores shutdown and SIGTERM is found by its command line and killed", async () => {
    // Stands in for a daemon from an earlier build that this app adopted, so its pid is unknown.
    const entry = join(socketDir, "old app", "pty-daemon", "index.js")
    await mkdir(join(socketDir, "old app", "pty-daemon"), { recursive: true })
    await writeFile(
      entry,
      "process.on('SIGTERM', () => {});require('node:net').createServer((s) => s.resume()).listen(process.argv[2])",
    )
    const old = spawn(process.execPath, [entry, socketPath], { stdio: "ignore" })
    const exited = new Promise((resolve) => old.once("exit", resolve))
    try {
      const deadline = Date.now() + 5_000
      while (!(await isDaemonListening(socketPath))) {
        if (Date.now() > deadline) throw new Error("fake daemon did not listen")
        await new Promise((done) => setTimeout(done, 20))
      }
      supervisor = new TerminalSupervisor({ socketPath })
      await supervisor.ensureClient()
      const warn = vi.fn()
      await supervisor.shutdownDaemon(300, warn)
      await exited
      expect(old.signalCode).toBe("SIGKILL")
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0]?.[0]).toContain(`pid ${old.pid}`)
    } finally {
      old.kill("SIGKILL")
    }
  })
})

describe("daemonPidsFromProcessList", () => {
  const socket = "/Users/me/Library/Application Support/PI Lab/pty-daemon.sock"
  test("matches only our daemon entry serving exactly this socket", () => {
    const list = [
      `  101 /Applications/PI Lab.app/Contents/MacOS/PI Lab /Applications/PI Lab.app/Contents/Resources/app.asar/out/pty-daemon/index.js ${socket}`,
      `  102 /Applications/PI Lab.app/Contents/MacOS/PI Lab /Applications/PI Lab.app/Contents/Resources/app.asar/out/pty-daemon/index.js ${socket}.other`,
      `  103 /Applications/PI Lab.app/Contents/MacOS/PI Lab /x/out/pty-daemon/index.js --alpha-reset-probe ${socket}`,
      `  104 /bin/zsh -c echo pty-daemon/index.js ${socket} && sleep 9`,
      `  105 /usr/bin/node /other/index.js ${socket}`,
      `  106 /Applications/PI Lab.app/Contents/MacOS/PI Lab`,
      "",
    ].join("\n")
    expect(daemonPidsFromProcessList(list, socket, 999)).toEqual([101])
  })

  test("never returns the calling process", () => {
    const list = ` 7 /a/PI Lab /a/out/pty-daemon/index.js ${socket}\n`
    expect(daemonPidsFromProcessList(list, socket, 7)).toEqual([])
  })
})
