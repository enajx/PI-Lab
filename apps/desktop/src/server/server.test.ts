import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client"
import superjson from "superjson"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { WebSocket } from "ws"
import type { ServerRouter } from "../main/trpc/serverRouter"
import { ensureLocalToken, TOKEN_FILE, TOKEN_HEADER } from "./access"
import { type ListeningServer, listen } from "./http"
import type { ServerRuntime } from "./runtime"

// The server must run without Electron: loading it in this test fails if any
// server module imports `electron`.
vi.mock("electron", () => {
  throw new Error("The PI Lab server loaded electron")
})

let dataDir: string
let runtime: ServerRuntime
let server: ListeningServer
let token: string

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "pi-lab-server-test-"))
  process.env.PI_LAB_DATA_DIR = dataDir
  process.env.PI_LAB_SOCKET_PATH = join(dataDir, "daemon.sock")
  const { ServerRuntime } = await import("./runtime")
  runtime = new ServerRuntime({
    dataDir,
    profileDir: dataDir,
    channel: "alpha",
    packaged: false,
    resourcesDir: join(dataDir, "resources"),
    build: "test-build",
    version: "0.0.0-test",
    port: 0,
  })
  await runtime.start()
  token = ensureLocalToken(dataDir)
  server = await listen({
    port: 0,
    token,
    serverId: "test-server-id",
    createContext: () => ({
      ...runtime.createAppContext(),
      server: { runtime, exit: () => undefined },
    }),
    handleScheme: async () => new Response(null, { status: 404 }),
  })
})

afterAll(async () => {
  await server?.close()
  runtime?.dispose()
  rmSync(dataDir, { recursive: true, force: true })
})

function connect(presented: string) {
  const socket = createWSClient({
    url: `ws://127.0.0.1:${server.port}/trpc?token=${encodeURIComponent(presented)}`,
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    retryDelayMs: () => 60_000,
  })
  return {
    client: createTRPCClient<ServerRouter>({
      links: [wsLink({ client: socket, transformer: superjson })],
    }),
    close: () => socket.close(),
  }
}

test("a client with the local token gets the hello and project data over loopback", async () => {
  const { client, close } = connect(token)
  const hello = await client.server.hello.query()
  expect(hello).toMatchObject({ protocol: 1, build: "test-build", version: "0.0.0-test" })
  expect(await client.projects.list.query()).toEqual([])
  close()
})

test("the local token file is readable by its owner only", () => {
  expect(statSync(join(dataDir, TOKEN_FILE)).mode & 0o777).toBe(0o600)
})

test("a WebSocket upgrade with a wrong token is refused before any call", async () => {
  const status = await new Promise<number>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/trpc?token=wrong`)
    socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0))
    socket.on("open", () => resolve(101))
  })
  expect(status).toBe(401)
})

test("plain HTTP requests need the token header", async () => {
  const health = `http://127.0.0.1:${server.port}/health`
  expect((await fetch(health)).status).toBe(401)
  expect((await fetch(health, { headers: { [TOKEN_HEADER]: "wrong" } })).status).toBe(401)
  expect((await fetch(health, { headers: { [TOKEN_HEADER]: token } })).status).toBe(200)
})

test("the server listens on loopback only", async () => {
  const address = (await import("node:os")).networkInterfaces()
  const external = Object.values(address)
    .flat()
    .find((entry) => entry && entry.family === "IPv4" && !entry.internal)
  if (!external) return
  const reached = await fetch(`http://${external.address}:${server.port}/health`, {
    headers: { [TOKEN_HEADER]: token },
    signal: AbortSignal.timeout(1_000),
  })
    .then(() => true)
    .catch(() => false)
  expect(reached).toBe(false)
})

test("a credential move interrupted halfway finishes on the next start, every key usable", async () => {
  const { agentCredentials, serviceCredentials } = await import("@pi-lab/local-db")
  const db = runtime.createAppContext().db
  // Values the old app wrote with Electron safeStorage (opaque here; no format prefix).
  db.insert(agentCredentials).values({ agentId: "claude-code", encryptedValue: "b2xkLWE=" }).run()
  db.insert(serviceCredentials).values({ service: "zotero", encryptedValue: "b2xkLWI=" }).run()

  // First start: the app moves one key, then quits before the second.
  const first = connect(token)
  const legacy = await first.client.server.legacyCredentials.query()
  expect(legacy.map((row) => row.key).sort()).toEqual(["claude-code", "zotero"])
  const agentRow = legacy.find((row) => row.key === "claude-code")
  if (!agentRow) throw new Error("missing legacy row")
  expect(
    await first.client.server.moveLegacyCredential.mutate({ ...agentRow, plaintext: "key-a" }),
  ).toEqual({ moved: true })
  first.close()

  // Next start: only the unmoved key is left, and it is moved too.
  const second = connect(token)
  const remaining = await second.client.server.legacyCredentials.query()
  expect(remaining.map((row) => row.key)).toEqual(["zotero"])
  const serviceRow = remaining[0]
  if (!serviceRow) throw new Error("missing legacy row")
  // A stale copy of an already moved row is not applied again.
  expect(
    await second.client.server.moveLegacyCredential.mutate({ ...agentRow, plaintext: "stale" }),
  ).toEqual({ moved: false })
  await second.client.server.moveLegacyCredential.mutate({ ...serviceRow, plaintext: "key-b" })
  expect(await second.client.server.legacyCredentials.query()).toEqual([])
  second.close()

  const rows = [
    ...db.select().from(agentCredentials).all(),
    ...db.select().from(serviceCredentials).all(),
  ]
  expect(rows.map((row) => runtime.secrets.decrypt(row.encryptedValue)).sort()).toEqual([
    "key-a",
    "key-b",
  ])
})

test("GET /identity answers only the server id, without the token", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/identity`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ serverId: "test-server-id" })
})

/** Real server and WebSocket; the updater's network engine is a recording stand-in (injected). */
test("public updates start with the server's data format and channel, and follow channel changes", async () => {
  const { PublicUpdateController } = await import("../main/updates/controller")
  const { startServerUpdates } = await import("../main/updates/serverUpdates")
  const { getDbStatus } = await import("../main/db/db")
  const configured: string[] = []
  const engine = {
    configure: (channel: string) => configured.push(channel),
    onAvailable: () => undefined,
    onDownloaded: () => undefined,
    onUnavailable: () => undefined,
    onError: () => undefined,
    check: async () => undefined,
    install: () => undefined,
  }
  const { client, close } = connect(token)
  await client.settings.updateGeneral.mutate({ publicUpdateChannel: "beta" })
  let compatibility: unknown = null
  let changes = 0
  const updates = await startServerUpdates(
    client,
    (current) => {
      compatibility = current
      return new PublicUpdateController(
        engine,
        current,
        () => undefined,
        () => undefined,
        () => undefined,
      )
    },
    () => {
      changes++
    },
  )
  expect(compatibility).toEqual(getDbStatus().compatibility)
  expect(configured).toEqual(["beta"])
  await client.settings.updateGeneral.mutate({ publicUpdateChannel: "stable" })
  await vi.waitFor(() => expect(updates.controller.current()).toEqual({ kind: "restart-required" }))
  expect(changes).toBe(1)
  updates.stop()
  close()
})
