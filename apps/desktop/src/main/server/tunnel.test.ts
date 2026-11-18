import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  SSHD_PATH,
  type SshTestServer,
  startSshTestServer,
} from "../../../../../tests/support/sshTestServer"
import {
  readRemoteDiscovery,
  SSH_PATH,
  SshTunnel,
  type TunnelOptions,
  type TunnelState,
} from "./tunnel"

/**
 * Real ssh against a throwaway user-level sshd on 127.0.0.1 (no mocks). The
 * "remote" server is a local HTTP server on 127.0.0.1, reached through the
 * tunnel as the remote machine's loopback.
 */

const sshAvailable = existsSync(SSH_PATH) && existsSync(SSHD_PATH)

function alive(pid: number): boolean {
  // ps exits 1 and prints nothing when the pid is gone.
  const out = spawnSync("ps", ["-o", "pid=", "-p", String(pid)], { encoding: "utf8" })
  return out.stdout.trim() !== ""
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe.skipIf(!sshAvailable)("SshTunnel (real ssh and sshd)", () => {
  let sshd: SshTestServer
  let http: Server
  let remotePort: number
  const tunnels: SshTunnel[] = []

  beforeAll(async () => {
    sshd = await startSshTestServer()
    http = createServer((_request, response) => response.end("hello from remote"))
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
    const address = http.address()
    if (address === null || typeof address === "string") throw new Error("no http port")
    remotePort = address.port
  })

  afterEach(async () => {
    for (const tunnel of tunnels.splice(0)) await tunnel.close()
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()))
    await sshd.stop()
  })

  function options(host: string, states: TunnelState[]): TunnelOptions {
    return {
      host,
      remotePort,
      sshPath: SSH_PATH,
      extraSshArgs: sshd.clientArgs,
      serverAliveIntervalSeconds: 5,
      serverAliveCountMax: 3,
      openTimeoutMs: 10_000,
      backoff: { initialMs: 100, maxMs: 1_000 },
      onState: (state) => states.push(state),
      log: () => {},
    }
  }

  async function open(states: TunnelState[]): Promise<SshTunnel> {
    const tunnel = await SshTunnel.open(options(sshd.host, states))
    tunnels.push(tunnel)
    return tunnel
  }

  async function get(port: number): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(5_000),
    })
    return response.text()
  }

  it("carries a request to the server on the remote port", async () => {
    const states: TunnelState[] = []
    const tunnel = await open(states)
    expect(tunnel.state).toBe("open")
    expect(tunnel.localPort).not.toBe(remotePort)
    expect(await get(tunnel.localPort)).toBe("hello from remote")
    expect(states).toEqual(["connecting", "open"])
  })

  it("reconnects on the same local port after ssh is killed", async () => {
    const states: TunnelState[] = []
    const tunnel = await open(states)
    const port = tunnel.localPort
    const firstPid = tunnel.pid
    if (firstPid === null) throw new Error("no ssh pid")
    process.kill(firstPid, "SIGKILL")
    await waitFor(() => states.includes("reconnecting"), 5_000, "reconnecting")
    await waitFor(() => states.at(-1) === "open" && states.length > 2, 10_000, "open again")
    expect(states).toEqual(["connecting", "open", "reconnecting", "open"])
    expect(tunnel.localPort).toBe(port)
    expect(tunnel.pid).not.toBe(firstPid)
    expect(await get(port)).toBe("hello from remote")
  })

  it("moves to a new local port when the old one is taken while reconnecting", async () => {
    const states: TunnelState[] = []
    const ports: number[] = []
    const tunnel = await SshTunnel.open({
      ...options(sshd.host, states),
      // Long enough to take the port before ssh restarts.
      backoff: { initialMs: 1_500, maxMs: 1_500 },
      onState: (state, localPort) => {
        states.push(state)
        ports.push(localPort)
      },
    })
    tunnels.push(tunnel)
    const oldPort = tunnel.localPort
    const firstPid = tunnel.pid
    if (firstPid === null) throw new Error("no ssh pid")
    process.kill(firstPid, "SIGKILL")
    await waitFor(() => !alive(firstPid), 5_000, "ssh exit")
    // Take the port before the backoff ends.
    const squatter = createServer()
    await new Promise<void>((resolve) => squatter.listen(oldPort, "127.0.0.1", resolve))
    await waitFor(() => states.length >= 4 && states.at(-1) === "open", 10_000, "open again")
    expect(tunnel.localPort).not.toBe(oldPort)
    expect(ports.at(-1)).toBe(tunnel.localPort)
    expect(await get(tunnel.localPort)).toBe("hello from remote")
    await new Promise<void>((resolve) => squatter.close(() => resolve()))
  })

  it("close() ends ssh and leaves no ssh process", async () => {
    const states: TunnelState[] = []
    const tunnel = await open(states)
    const pid = tunnel.pid
    if (pid === null) throw new Error("no ssh pid")
    const port = tunnel.localPort
    await tunnel.close()
    expect(tunnel.state).toBe("closed")
    expect(states.at(-1)).toBe("closed")
    expect(alive(pid)).toBe(false)
    const forward = `127.0.0.1:${port}:127.0.0.1:${remotePort}`
    const left = execFileSync("ps", ["-axo", "command="], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes(forward))
    expect(left).toEqual([])
    // No restart after close.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(states.at(-1)).toBe("closed")
  })

  it("fails with ssh's error for a wrong host", async () => {
    const states: TunnelState[] = []
    const started = Date.now()
    await expect(SshTunnel.open(options("no-such-host.invalid", states))).rejects.toThrow(
      /Could not resolve hostname no-such-host\.invalid/,
    )
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(states.at(-1)).toBe("closed")
  })

  it("reads the remote discovery file, with a clear error when it is missing", async () => {
    const dataDir = join(sshd.dir, "data dir")
    mkdirSync(dataDir)
    const base = {
      sshPath: SSH_PATH,
      host: sshd.host,
      extraSshArgs: sshd.clientArgs,
      dataDir,
      timeoutMs: 10_000,
    }
    await expect(readRemoteDiscovery(base)).rejects.toThrow(
      /No server\.json .*is the PI Lab server running/,
    )
    writeFileSync(
      join(dataDir, "server.json"),
      `${JSON.stringify({ port: 4123, pid: 77, build: "abc", serverId: "remote-id" })}\n`,
    )
    expect(await readRemoteDiscovery(base)).toEqual({
      port: 4123,
      pid: 77,
      build: "abc",
      serverId: "remote-id",
    })
  })
})
