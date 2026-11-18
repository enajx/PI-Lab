import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveDataDir } from "@pi-lab/local-db"
import { afterEach, beforeEach, expect, test } from "vitest"
import { ensureLocalToken, TOKEN_HEADER, writeDiscovery } from "../../server/access"
import { createServerClient } from "./client"
import { runningServer, serverLaunchConfig, stopServerSync, verifiedEndpoint } from "./launcher"

let dataDir: string
const cleanups: Array<() => void | Promise<void>> = []

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "pi-lab-launcher-test-"))
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  rmSync(dataDir, { recursive: true, force: true })
})

/** Point HOME at a temp folder and clear PI_LAB_DATA_DIR, as in a default Stable install. */
function defaultInstallEnv(): string {
  const home = mkdtempSync(join(tmpdir(), "pi-lab-launcher-home-"))
  const saved = { HOME: process.env.HOME, PI_LAB_DATA_DIR: process.env.PI_LAB_DATA_DIR }
  process.env.HOME = home
  delete process.env.PI_LAB_DATA_DIR
  cleanups.push(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

test("with PI_LAB_DATA_DIR unset the server uses the old app's data folder, not Electron's profile", () => {
  const home = defaultInstallEnv()
  const profileDir = join(home, "Library", "Application Support", "PI Lab")
  const config = serverLaunchConfig({
    channel: "stable",
    packaged: true,
    resourcesDir: "/Applications/PI Lab.app/Contents/Resources",
    build: "build-a",
    version: "1.0.0",
    profileDir,
  })
  expect(config.dataDir).toBe(resolveDataDir())
  expect(config.dataDir).toBe(join(home, ".pi-lab"))
  // Electron's own files (interface language, Analysis structure) stay in its profile.
  expect(config.profileDir).toBe(profileDir)
})

/** A local HTTP service that took the discovered port: it records every request. */
async function impostor(): Promise<{ port: number; requests: IncomingMessage[] }> {
  const requests: IncomingMessage[] = []
  const server: Server = createServer((request, response) => {
    requests.push(request)
    if (request.url === "/identity") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ serverId: "someone-else" }))
      return
    }
    // A redirect to itself, to check clients do not follow redirects either.
    response.writeHead(302, { location: `${request.url}?again=1` }).end()
  })
  server.on("upgrade", (request, socket) => {
    requests.push(request)
    socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { port: (server.address() as AddressInfo).port, requests }
}

/** True when any recorded request carried the token, in a header or the URL. */
function sawToken(requests: IncomingMessage[], token: string): boolean {
  return requests.some(
    (request) =>
      request.headers[TOKEN_HEADER] === token ||
      (request.url ?? "").includes(encodeURIComponent(token)),
  )
}

test("a stale server.json naming another service's port never sends it the token", async () => {
  const token = ensureLocalToken(dataDir)
  const fake = await impostor()
  // The pid is alive (this test process), as after pid reuse.
  writeDiscovery(dataDir, { port: fake.port, pid: process.pid, build: "b", serverId: "ours" })

  expect(await runningServer(dataDir)).toBeNull()
  await expect(verifiedEndpoint(dataDir, token)).rejects.toThrow(/not this PI Lab server/)

  // Electron's own server client asks for the same verified endpoint on every attempt.
  const connection = createServerClient(() => verifiedEndpoint(dataDir, token))
  cleanups.push(() => connection.close())
  const hello = connection.client.server.hello.query()
  await new Promise((resolve) => setTimeout(resolve, 500))
  connection.close()
  await expect(hello).rejects.toThrow()

  expect(fake.requests.some((request) => request.url === "/identity")).toBe(true)
  expect(sawToken(fake.requests, token)).toBe(false)
})

test("Alpha reset never signals an unrelated process left in server.json", async () => {
  const child: ChildProcess = spawn("sleep", ["30"], { stdio: "ignore" })
  cleanups.push(() => {
    child.kill("SIGKILL")
  })
  const pid = child.pid
  if (!pid) throw new Error("sleep did not start")
  writeDiscovery(dataDir, { port: 1, pid, build: "b", serverId: "ours" })
  stopServerSync(dataDir, null)
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(child.exitCode).toBeNull()
  expect(child.signalCode).toBeNull()
})
