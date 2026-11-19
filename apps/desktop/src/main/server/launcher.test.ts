import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveDataDir } from "@pi-lab/local-db"
import { afterEach, beforeEach, expect, test } from "vitest"
import { ensureLocalToken, identityProof, TOKEN_HEADER, writeDiscovery } from "../../server/access"
import { createServerClient } from "./client"
import {
  createEndpointCache,
  ensureServer,
  isPiLabServerProcess,
  runningServer,
  serverLaunchConfig,
  stopServerSync,
  verifiedEndpoint,
} from "./launcher"

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

/**
 * A local HTTP service that took the discovered port: it records every request
 * and answers `/identity` with `identity` (a fixed body, as a replay would).
 */
async function impostor(identity: object): Promise<{ port: number; requests: IncomingMessage[] }> {
  const requests: IncomingMessage[] = []
  const server: Server = createServer((request, response) => {
    requests.push(request)
    if ((request.url ?? "").startsWith("/identity")) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(identity))
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
  const fake = await impostor({ serverId: "ours" })
  // The pid is alive (this test process), as after pid reuse.
  writeDiscovery(dataDir, { port: fake.port, pid: process.pid, build: "b", serverId: "ours" })

  expect(await runningServer(dataDir)).toBeNull()
  await expect(verifiedEndpoint(dataDir, token)).rejects.toThrow(/not this PI Lab server/)

  // Electron's own server client asks for the same verified endpoint on every attempt.
  const connection = createServerClient(
    () => verifiedEndpoint(dataDir, token),
    () => undefined,
  )
  cleanups.push(() => connection.close())
  const hello = connection.client.server.hello.query()
  await new Promise((resolve) => setTimeout(resolve, 500))
  connection.close()
  await expect(hello).rejects.toThrow()

  expect(fake.requests.some((request) => request.url?.startsWith("/identity?nonce="))).toBe(true)
  expect(sawToken(fake.requests, token)).toBe(false)
})

test("a process that replays an earlier real /identity answer never gets the token", async () => {
  const token = ensureLocalToken(dataDir)
  // What the real server answered for an earlier client's nonce, captured and replayed.
  const replayed = { proof: identityProof(token, "00112233445566778899aabbccddeeff") }
  const fake = await impostor(replayed)
  writeDiscovery(dataDir, { port: fake.port, pid: process.pid, build: "b", serverId: "ours" })

  expect(await runningServer(dataDir)).toBeNull()
  await expect(verifiedEndpoint(dataDir, token)).rejects.toThrow(/not this PI Lab server/)
  const nonces = fake.requests.map(
    (request) => new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("nonce") ?? "",
  )
  expect(nonces.length).toBeGreaterThan(0)
  expect(new Set(nonces).size).toBe(nonces.length)
  for (const nonce of nonces) expect(nonce).toMatch(/^[0-9a-f]{32}$/)
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

/** Wait until `check` is true, polling every 25 ms, for at most `ms`. */
async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  return check()
}

/**
 * A live stand-in process whose command line looks like a PI Lab server's
 * (`…/out/main/server.js <data folder>`). It runs no server code.
 */
function serverLookalike(serverDataDir: string): ChildProcess {
  const entry = join(dataDir, "old-app", "out", "main", "server.js")
  const child = spawn("node", ["-e", "setInterval(() => {}, 1000)", entry, serverDataDir], {
    stdio: "ignore",
  })
  cleanups.push(() => {
    child.kill("SIGKILL")
  })
  return child
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

test("only a server process of this data folder counts as this data folder's server", async () => {
  const ours = serverLookalike(dataDir)
  const theirs = serverLookalike(join(dataDir, "other-data"))
  await waitUntil(() => false, 200)
  expect(isPiLabServerProcess(ours.pid ?? 0, dataDir)).toBe(true)
  expect(isPiLabServerProcess(theirs.pid ?? 0, dataDir)).toBe(false)
  // A data folder that only starts like ours is another folder.
  expect(isPiLabServerProcess(ours.pid ?? 0, join(dataDir, "other-data"))).toBe(false)
})

test("Alpha reset never signals a server process of another data folder", async () => {
  const theirs = serverLookalike(join(dataDir, "other-data"))
  await waitUntil(() => false, 200)
  writeDiscovery(dataDir, { port: 1, pid: theirs.pid ?? 0, build: "b", serverId: "ours" })
  stopServerSync(dataDir, null)
  await waitUntil(() => false, 200)
  expect(exited(theirs)).toBe(false)
})

/**
 * A stand-in server bundle (no PI Lab code): it proves the token at
 * `/identity`, answers `/health` and writes `server.json` like the real one.
 */
function fakeServerEntry(): string {
  const entry = join(dataDir, "new-app", "out", "main", "server.js")
  mkdirSync(join(dataDir, "new-app", "out", "main"), { recursive: true })
  writeFileSync(
    entry,
    `const { createServer } = require("node:http")
const { createHmac, randomBytes } = require("node:crypto")
const { readFileSync, writeFileSync } = require("node:fs")
const { join } = require("node:path")
const dataDir = process.env.PI_LAB_DATA_DIR
const token = readFileSync(join(dataDir, "server-token"), "utf8").trim()
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1")
  if (url.pathname === "/identity") {
    const nonce = url.searchParams.get("nonce")
    const proof = createHmac("sha256", token).update("pi-lab-identity:" + nonce).digest("hex")
    response.end(JSON.stringify({ proof }))
    return
  }
  if (url.pathname === "/health" && request.headers["x-pi-lab-token"] === token) {
    response.end("ok")
    return
  }
  response.writeHead(401).end()
})
server.listen(0, "127.0.0.1", () => {
  const discovery = { port: server.address().port, pid: process.pid, build: process.env.PI_LAB_BUILD, serverId: randomBytes(8).toString("hex") }
  writeFileSync(join(dataDir, "server.json"), JSON.stringify(discovery))
})
`,
  )
  return entry
}

/** Stand-in server bundle in a detached child; the old server is a lookalike process. */
test.each([
  ["without a serverId", (pid: number) => ({ port: 1, pid, build: "old" })],
  [
    "with a serverId but no HMAC proof",
    (pid: number) => ({ port: 1, pid, build: "old", serverId: "x" }),
  ],
])("a running server from an older build %s is stopped before the new one starts", async (_name, discovery) => {
  ensureLocalToken(dataDir)
  const old = serverLookalike(dataDir)
  await waitUntil(() => false, 200)
  // server.json as an older build wrote it.
  writeFileSync(join(dataDir, "server.json"), JSON.stringify(discovery(old.pid ?? 0)))
  const endpoint = await ensureServer({
    config: { ...serverLaunchConfig(launchInput()), dataDir },
    serverEntry: fakeServerEntry(),
    launchdLabel: null,
    log: () => undefined,
    noProgressMs: 30_000,
  })
  cleanups.push(() => {
    if (endpoint.pid) process.kill(endpoint.pid, "SIGKILL")
  })
  expect(exited(old)).toBe(true)
  expect(endpoint.pid).not.toBe(old.pid)
  expect(endpoint.build).toBe("build-new")
})

function launchInput() {
  return {
    channel: "alpha" as const,
    packaged: false,
    resourcesDir: dataDir,
    build: "build-new",
    version: "0.0.0-test",
    profileDir: dataDir,
  }
}

/** A loopback service that proves the token, counting `/identity` requests. */
async function provingServer(
  token: string,
): Promise<{ port: number; identityChecks: () => number }> {
  let checks = 0
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/identity") {
      checks++
      response.end(
        JSON.stringify({ proof: identityProof(token, url.searchParams.get("nonce") ?? "") }),
      )
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { port: (server.address() as AddressInfo).port, identityChecks: () => checks }
}

test("forwarded requests reuse one identity check until server.json changes or a request fails", async () => {
  const token = ensureLocalToken(dataDir)
  const server = await provingServer(token)
  writeDiscovery(dataDir, { port: server.port, pid: process.pid, build: "b", serverId: "first" })
  const endpoints = createEndpointCache(dataDir, token)

  const many = await Promise.all(Array.from({ length: 20 }, () => endpoints.get()))
  for (let request = 0; request < 5; request++) await endpoints.get()
  expect(many.every((endpoint) => endpoint.port === server.port)).toBe(true)
  expect(server.identityChecks()).toBe(1)

  endpoints.invalidate()
  await endpoints.get()
  expect(server.identityChecks()).toBe(2)

  // A restarted server writes a new serverId.
  writeDiscovery(dataDir, { port: server.port, pid: process.pid, build: "b", serverId: "second" })
  await endpoints.get()
  await endpoints.get()
  expect(server.identityChecks()).toBe(3)
})

/**
 * A stand-in server bundle (no PI Lab code) that writes its start steps to
 * `server-start.json` like the real server, runs `body`, and then serves like
 * {@link fakeServerEntry} when `body` calls `listenNow()`.
 */
function steppingServerEntry(name: string, body: string): string {
  const dir = join(dataDir, name, "out", "main")
  mkdirSync(dir, { recursive: true })
  const entry = join(dir, "server.js")
  writeFileSync(
    entry,
    `const { createServer } = require("node:http")
const { createHmac, randomBytes } = require("node:crypto")
const { readFileSync, writeFileSync } = require("node:fs")
const { join } = require("node:path")
const dataDir = process.env.PI_LAB_DATA_DIR
const token = readFileSync(join(dataDir, "server-token"), "utf8").trim()
const step = (name) =>
  writeFileSync(join(dataDir, "server-start.json"), JSON.stringify({ pid: process.pid, step: name, at: Date.now() }))
const listenNow = () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")
    if (url.pathname === "/identity") {
      const nonce = url.searchParams.get("nonce")
      response.end(JSON.stringify({ proof: createHmac("sha256", token).update("pi-lab-identity:" + nonce).digest("hex") }))
      return
    }
    if (url.pathname === "/health" && request.headers["x-pi-lab-token"] === token) return void response.end("ok")
    response.writeHead(401).end()
  })
  server.listen(0, "127.0.0.1", () => {
    const discovery = { port: server.address().port, pid: process.pid, build: process.env.PI_LAB_BUILD, serverId: randomBytes(8).toString("hex") }
    writeFileSync(join(dataDir, "server.json"), JSON.stringify(discovery))
  })
}
${body}
`,
  )
  return entry
}

/** Start the stand-in `entry` through ensureServer with a short no-progress limit. */
function ensureStandIn(entry: string, noProgressMs: number) {
  ensureLocalToken(dataDir)
  const result = ensureServer({
    config: { ...serverLaunchConfig(launchInput()), dataDir },
    serverEntry: entry,
    launchdLabel: null,
    log: () => undefined,
    noProgressMs,
  })
  result.then(
    (endpoint) => cleanups.push(() => void process.kill(endpoint.pid, "SIGKILL")),
    () => undefined,
  )
  return result
}

test("a server that starts slowly but keeps reporting steps is waited for", async () => {
  // Steps every 300 ms, listening after 3 s: longer than the 1 s no-progress limit.
  const entry = steppingServerEntry(
    "slow",
    `let n = 0
const timer = setInterval(() => step("step-" + n++), 300)
setTimeout(() => { clearInterval(timer); step("listening"); listenNow() }, 3_000)`,
  )
  const endpoint = await ensureStandIn(entry, 1_000)
  expect(endpoint.build).toBe("build-new")
}, 15_000)

test("a server that exits while starting fails at once with its log tail", async () => {
  const entry = steppingServerEntry(
    "crash",
    `step("migrating")
console.error("stand-in crash: disk on fire")
process.exit(1)`,
  )
  const started = Date.now()
  await expect(ensureStandIn(entry, 60_000)).rejects.toThrow(
    /exited while starting[\s\S]*stand-in crash: disk on fire/,
  )
  expect(Date.now() - started).toBeLessThan(5_000)
}, 15_000)

test("a server that stays alive with no progress fails after the no-progress limit", async () => {
  const entry = steppingServerEntry("stuck", `step("migrating")\nsetInterval(() => {}, 1_000)`)
  const started = Date.now()
  await expect(ensureStandIn(entry, 1_500)).rejects.toThrow(
    /no progress for 1\.5 s[\s\S]*migrating/,
  )
  expect(Date.now() - started).toBeLessThan(8_000)
  const stuck = JSON.parse(readFileSync(join(dataDir, "server-start.json"), "utf8")) as {
    pid: number
  }
  process.kill(stuck.pid, "SIGKILL")
}, 15_000)
