import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonServer } from "@pi-lab/pty-daemon"
import { createTRPCClient, createWSClient, TRPCClientError, wsLink } from "@trpc/client"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { WebSocket } from "ws"
import { z } from "zod"
import type { ServerRouter } from "../main/trpc/serverRouter"
import {
  appSettingsSchema,
  backgroundTraySnapshotSchema,
  legacyCredentialSchema,
  notificationEventSchema,
  notificationStreamMessageSchema,
  projectFileRouteSchema,
  quitWorkSchema,
  secretProtectionSchema,
  serverHelloSchema,
} from "../shared/clientApi"
import { ensureLocalToken, TOKEN_FILE, TOKEN_HEADER } from "./access"
import { DEVICES_FILE } from "./devices"
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
let daemonServer: DaemonServer

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "pi-lab-server-test-"))
  process.env.PI_LAB_DATA_DIR = dataDir
  process.env.PI_LAB_SOCKET_PATH = join(dataDir, "daemon.sock")
  // A real PTY daemon in this process; the server adopts it as a running daemon.
  daemonServer = new DaemonServer({ socketPath: process.env.PI_LAB_SOCKET_PATH })
  await daemonServer.listen()
  const { ServerRuntime } = await import("./runtime")
  runtime = new ServerRuntime({
    dataDir,
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
    access: runtime.devices,
    testRoutes: false,
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
  await daemonServer?.close()
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
      links: [wsLink({ client: socket })],
    }),
    close: () => socket.close(),
  }
}

test("a client with the local token gets the hello and project data over loopback", async () => {
  const { client, close } = connect(token)
  const hello = await client.server.hello.query()
  expect(hello).toMatchObject({ protocol: 1, build: "test-build", version: "0.0.0-test" })
  expect(hello.capabilities).toEqual(["devices", "launch-ids", "answer-request"])
  expect(await client.projects.list.query()).toEqual([])
  close()
})

test("the local token file is readable by its owner only", () => {
  expect(statSync(join(dataDir, TOKEN_FILE)).mode & 0o777).toBe(0o600)
})

/** HTTP status of a WebSocket upgrade with this token (101 when it opens). */
function upgradeStatus(presented: string): Promise<number> {
  return new Promise<number>((resolve) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/trpc?token=${encodeURIComponent(presented)}`,
    )
    socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0))
    socket.on("open", () => {
      socket.close()
      resolve(101)
    })
  })
}

test("a WebSocket upgrade with a wrong token is refused before any call", async () => {
  expect(await upgradeStatus("wrong")).toBe(401)
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

test("server results and events match the client API over the plain JSON socket", async () => {
  const { client, close } = connect(token)
  const expectWire = <T>(schema: z.ZodType<T>, value: unknown) =>
    expect(schema.parse(value)).toEqual(value)
  expectWire(serverHelloSchema, await client.server.hello.query())
  expectWire(appSettingsSchema, await client.server.appSettings.query())
  expectWire(backgroundTraySnapshotSchema, await client.server.traySnapshot.query())
  expectWire(quitWorkSchema, await client.server.quitWork.query())
  expectWire(secretProtectionSchema, await client.server.secretProtection.query())
  expectWire(z.array(legacyCredentialSchema), await client.server.legacyCredentials.query())
  expectWire(z.boolean(), await client.server.hasProject.query({ id: "missing" }))
  expectWire(projectFileRouteSchema, await client.server.projectForFile.query({ path: dataDir }))

  const events: unknown[] = []
  const tray = client.server.onTray.subscribe(undefined, { onData: (event) => events.push(event) })
  const settings = await new Promise<unknown>((resolve) => {
    const subscription = client.server.onAppSettings.subscribe(undefined, {
      onData: (event) => {
        subscription.unsubscribe()
        resolve(event)
      },
    })
  })
  expectWire(appSettingsSchema, settings)

  const notification = new Promise<unknown>((resolve) => {
    const subscription = client.server.onNotification.subscribe(undefined, {
      onStarted: () =>
        runtime.notifications.notify({
          eventType: "workflowCompletion",
          title: "Done",
          body: "The workflow finished",
          target: { type: "workflow", workflowId: "w", runId: "r" },
        }),
      onData: (event) => {
        subscription.unsubscribe()
        resolve(event)
      },
    })
  })
  expectWire(notificationStreamMessageSchema, await notification)
  expectWire(z.array(notificationEventSchema), await client.server.notificationHistory.query())
  tray.unsubscribe()
  for (const event of events) expectWire(backgroundTraySnapshotSchema, event)
  close()
})

test("an error reaches the client with its code and message and no stack trace", async () => {
  const { client, close } = connect(token)
  const error = await client.projects.get.query({ id: "missing-project" }).catch((e) => e)
  expect(error).toBeInstanceOf(TRPCClientError)
  expect(error.message).toBe("No project missing-project")
  expect(error.data.code).toBe("NOT_FOUND")
  expect(error.data.stack).toBeUndefined()
  close()
})

test("a revoked device token is refused, and its open connection closes at once", async () => {
  const local = connect(token)
  const created = await local.client.server.devices.create.mutate({ name: "Laptop" })
  expect(created.token.length).toBeGreaterThanOrEqual(32)
  expect(created.device).toMatchObject({ name: "Laptop", local: false, revokedAt: null })

  // Only a hash is stored, in an owner-only file.
  const stored = readFileSync(join(dataDir, DEVICES_FILE), "utf8")
  expect(stored).not.toContain(created.token)
  expect(statSync(join(dataDir, DEVICES_FILE)).mode & 0o777).toBe(0o600)

  const listed = await local.client.server.devices.list.query()
  expect(listed.map((device) => [device.name, device.local])).toEqual([
    ["This Mac", true],
    ["Laptop", false],
  ])
  expect(JSON.stringify(listed)).not.toContain(created.token)

  // The new device connects over the socket and over plain HTTP.
  const laptopSocket = new WebSocket(
    `ws://127.0.0.1:${server.port}/trpc?token=${encodeURIComponent(created.token)}`,
  )
  await new Promise((resolve, reject) => {
    laptopSocket.once("open", resolve)
    laptopSocket.once("error", reject)
  })
  const health = `http://127.0.0.1:${server.port}/health`
  expect((await fetch(health, { headers: { [TOKEN_HEADER]: created.token } })).status).toBe(200)

  // Revoking closes its open connection at once; later upgrades and requests get 401.
  const closed = new Promise<number>((resolve) => laptopSocket.once("close", resolve))
  await local.client.server.devices.revoke.mutate({ id: created.device.id })
  expect(await closed).toBe(1008)
  expect(await upgradeStatus(created.token)).toBe(401)
  expect((await fetch(health, { headers: { [TOKEN_HEADER]: created.token } })).status).toBe(401)
  const revoked = (await local.client.server.devices.list.query()).find(
    (device) => device.id === created.device.id,
  )
  expect(revoked?.revokedAt).toEqual(expect.any(Number))

  // The local device token cannot be revoked, and still works.
  const localDevice = listed.find((device) => device.local)
  if (!localDevice) throw new Error("missing local device")
  await expect(local.client.server.devices.revoke.mutate({ id: localDevice.id })).rejects.toThrow(
    "The local device cannot be revoked",
  )
  expect(await upgradeStatus(token)).toBe(101)
  local.close()
})

test("two devices answer the same request: the first is accepted, the other's text never reaches the agent", async () => {
  // A real PTY in the real daemon: the agent prints a prompt and writes every line it reads to a file.
  const received = join(dataDir, "answers.txt")
  const daemon = await runtime.createAppContext().getDaemonClient()
  const session = await daemon.spawn({
    command: process.execPath,
    args: [
      "-e",
      `process.stdout.write("Allow this command? [y/N] ");process.stdin.on("data",(d)=>require("node:fs").appendFileSync(${JSON.stringify(received)},d))`,
    ],
    env: { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: "1" },
  })

  const first = connect(token)
  const second = connect(token)
  /** Collect one client's notification stream. */
  const stream = (client: typeof first.client) => {
    const messages: Array<{ type: string; id?: string; event?: { id: string } }> = []
    const started = new Promise<void>((resolve) => {
      client.server.onNotification.subscribe(undefined, {
        onStarted: () => resolve(),
        onData: (message) => messages.push(message),
      })
    })
    return { messages, started }
  }
  const firstStream = stream(first.client)
  const secondStream = stream(second.client)
  await Promise.all([firstStream.started, secondStream.started])

  // The pending request, as the activity monitor raises it when the agent waits.
  runtime.notifications.notify({
    eventType: "agentInput",
    title: "Agent needs input",
    body: "Allow this command?",
    target: {
      type: "agent",
      projectId: "project",
      workspaceId: "workspace",
      sessionId: session.id,
      agentId: "test-agent",
      origin: "project",
    },
  })
  await vi.waitFor(() => expect(secondStream.messages).toHaveLength(1))
  const requestId = secondStream.messages[0]?.event?.id
  if (!requestId) throw new Error("no pending request")

  const answers = await Promise.all([
    first.client.server.answerRequest.mutate({ requestId, text: "yes from laptop" }),
    second.client.server.answerRequest.mutate({ requestId, text: "no from phone" }),
  ])
  expect(answers).toEqual([{ status: "accepted" }, { status: "already-answered" }])

  // The request clears on every device.
  for (const { messages } of [firstStream, secondStream]) {
    await vi.waitFor(() => expect(messages).toContainEqual({ type: "cleared", id: requestId }))
  }
  await vi.waitFor(() => expect(readFileSync(received, "utf8")).toContain("yes from laptop"))
  // Let any stray write land before checking it never came.
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(readFileSync(received, "utf8")).not.toContain("no from phone")
  expect(await second.client.server.answerRequest.mutate({ requestId, text: "late" })).toEqual({
    status: "already-answered",
  })

  await daemon.kill(session.id)
  first.close()
  second.close()
})
