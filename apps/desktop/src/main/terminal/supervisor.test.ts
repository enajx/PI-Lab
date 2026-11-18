// Tests for the daemon supervisor that DON'T spawn a detached child (that path
// is exercised by the app/verify harness). We cover the pure spawn plan, the
// liveness probe, and the *adopt* branch against an in-process DaemonServer.

import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonServer, PROTOCOL_VERSION } from "@pi-lab/pty-daemon"
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
    await monitorClient.attach(session.id, null)
    await rendererClient.detach(session.id)

    const observed = new Promise<string>((resolve) => {
      monitorClient.on("data", (event) => {
        const text = event.bytes.toString()
        if (event.sessionId === session.id && text.includes("monitor-alive")) resolve(text)
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
    // The daemon signals the shell and does not wait for it, so it can exit a few ms later.
    await vi.waitFor(() => expect(() => process.kill(shell.pid as number, 0)).toThrow(/ESRCH/), {
      timeout: 2_000,
    })
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

  test("a daemon that never answers list leaves no open sockets after repeated connect attempts", async () => {
    // Accepts connections and reads requests, never answers.
    const silent = createServer((socket) => socket.resume())
    await new Promise<void>((resolve) => silent.listen(socketPath, resolve))
    try {
      supervisor = new TerminalSupervisor({ socketPath, spawnTimeoutMs: 100 })
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(supervisor.ensureClient()).rejects.toThrow(/did not answer/)
      }
      await vi.waitFor(async () => {
        const open = await new Promise<number>((resolve, reject) =>
          silent.getConnections((error, count) => (error ? reject(error) : resolve(count))),
        )
        expect(open).toBe(0)
      })
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
      `process.on('SIGTERM', () => {});require('node:net').createServer((s) => s.on('data', (d) => { const f = JSON.parse(d.toString()); if (f.kind === 'list') s.write(JSON.stringify({ kind: 'list-ok', cid: f.cid, sessions: [], protocol: ${PROTOCOL_VERSION} }) + '\\n') })).listen(process.argv[2])`,
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

describe("adopting a daemon by protocol", () => {
  /** A stand-in for a version 1 daemon: answers list without a protocol field, and shutdown by closing. */
  async function startFakeV1Daemon(): Promise<{ requests: string[]; close: () => Promise<void> }> {
    const requests: string[] = []
    const sockets = new Set<import("node:net").Socket>()
    const fake = createServer((socket) => {
      sockets.add(socket)
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString()
        for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
          const frame = JSON.parse(buffer.slice(0, at)) as { kind: string; cid: string }
          buffer = buffer.slice(at + 1)
          requests.push(frame.kind)
          if (frame.kind === "list") {
            socket.write(`${JSON.stringify({ kind: "list-ok", cid: frame.cid, sessions: [] })}\n`)
          } else if (frame.kind === "shutdown") {
            socket.write(
              `${JSON.stringify({ kind: "shutdown-ok", cid: frame.cid, pid: process.pid })}\n`,
            )
            fake.close()
            for (const open of sockets) open.end()
          }
        }
      })
      socket.on("error", () => {})
    })
    await new Promise<void>((resolve) => fake.listen(socketPath, resolve))
    return {
      requests,
      close: async () => {
        for (const open of sockets) open.destroy()
        if (fake.listening) await new Promise((resolve) => fake.close(resolve))
      },
    }
  }

  /** Bundle the current daemon source (the built out/ bundle can be stale) next to node_modules. */
  async function buildDaemonEntry(): Promise<string> {
    const desktopDir = join(__dirname, "..", "..", "..")
    const dir = await mkdtemp(join(desktopDir, "node_modules", ".test-daemon-"))
    const entry = join(dir, "index.js")
    execFileSync("bun", [
      "build",
      join(desktopDir, "src", "main", "terminal", "daemonEntry.ts"),
      "--target=node",
      "--format=esm",
      "--external=node-pty",
      "--external=@xterm/headless",
      "--external=@pi-lab/pty-termios",
      `--outfile=${entry}`,
    ])
    await writeFile(join(dir, "package.json"), '{"type":"module"}')
    return entry
  }

  test("an adopted version 1 daemon is shut down and replaced by a current one", async () => {
    const entry = await buildDaemonEntry()
    const fake = await startFakeV1Daemon()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      supervisor = new TerminalSupervisor({ socketPath, daemonEntry: entry })
      const client = await supervisor.ensureClient()
      expect(fake.requests).toContain("shutdown")
      expect(await client.protocolVersion()).toBe(PROTOCOL_VERSION)
      const session = await client.spawn({ command: "/bin/cat", args: [] })
      expect(session.id).toBeTruthy()
      expect(warn.mock.calls[0]?.[0]).toMatch(
        new RegExp(`protocol 1.*protocol ${PROTOCOL_VERSION}`, "s"),
      )
      await supervisor.shutdownDaemon(2_000, vi.fn())
    } finally {
      warn.mockRestore()
      await fake.close()
      await rm(join(entry, ".."), { recursive: true, force: true })
    }
  })

  test("an adopted old daemon that ignores shutdown is stopped by pid and replaced", async () => {
    // Stands in for a version 1 daemon from an earlier build: answers list without a
    // protocol field and ignores shutdown, so only its pid can stop it.
    const entry = await buildDaemonEntry()
    const oldEntry = join(socketDir, "old app", "pty-daemon", "index.js")
    await mkdir(join(socketDir, "old app", "pty-daemon"), { recursive: true })
    await writeFile(
      oldEntry,
      `require('node:net').createServer((s) => s.on('data', (d) => { for (const line of d.toString().split('\\n').filter(Boolean)) { const f = JSON.parse(line); if (f.kind === 'list') s.write(JSON.stringify({ kind: 'list-ok', cid: f.cid, sessions: [] }) + '\\n') } })).listen(process.argv[2])`,
    )
    const old = spawn(process.execPath, [oldEntry, socketPath], { stdio: "ignore" })
    const exited = new Promise((resolve) => old.once("exit", resolve))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const deadline = Date.now() + 5_000
      while (!(await isDaemonListening(socketPath))) {
        if (Date.now() > deadline) throw new Error("fake daemon did not listen")
        await new Promise((done) => setTimeout(done, 20))
      }
      supervisor = new TerminalSupervisor({ socketPath, daemonEntry: entry, spawnTimeoutMs: 1_000 })
      const client = await supervisor.ensureClient()
      await exited
      expect(old.signalCode).toBe("SIGTERM")
      expect(await client.protocolVersion()).toBe(PROTOCOL_VERSION)
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(`pid ${old.pid}`)
      await supervisor.shutdownDaemon(2_000, vi.fn())
    } finally {
      warn.mockRestore()
      old.kill("SIGKILL")
      await rm(join(entry, ".."), { recursive: true, force: true })
    }
  })

  test("an adopted current daemon is kept", async () => {
    server = new DaemonServer({ socketPath })
    await server.listen()
    const shutdown = vi.spyOn(server, "close")
    supervisor = new TerminalSupervisor({ socketPath, daemonEntry: join(socketDir, "missing.js") })
    const client = await supervisor.ensureClient()
    expect(await client.protocolVersion()).toBe(PROTOCOL_VERSION)
    expect(shutdown).not.toHaveBeenCalled()
    expect(await isDaemonListening(socketPath)).toBe(true)
  })
})

describe("slow daemon start", () => {
  test("a daemon child that is alive but slow to listen is waited for past 5 s", async () => {
    // Listens after 6 s, as on a fully loaded machine.
    const entry = join(socketDir, "slow-start-daemon.js")
    await writeFile(
      entry,
      // Answers the protocol check like a current daemon once it listens.
      `setTimeout(() => require('node:net').createServer((s) => { let b = ''; s.on('data', (d) => { b += d; let i; while ((i = b.indexOf('\\n')) >= 0) { const m = JSON.parse(b.slice(0, i)); b = b.slice(i + 1); if (m.kind === 'list') s.write(JSON.stringify({ kind: 'list-ok', cid: m.cid, sessions: [], protocol: ${PROTOCOL_VERSION} }) + '\\n') } }) }).listen(process.argv[2]), 6_000)`,
    )
    supervisor = new TerminalSupervisor({
      socketPath,
      daemonEntry: entry,
      reapDaemonOnDispose: true,
    })
    await expect(supervisor.ensureClient()).resolves.toBeTruthy()
  }, 20_000)
})
