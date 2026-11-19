import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
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
  notebookCountSchema,
  notificationEventSchema,
  notificationStreamMessageSchema,
  projectFileRouteSchema,
  quitWorkSchema,
  secretProtectionSchema,
  serverHelloSchema,
} from "../shared/clientApi"
import {
  ensureLocalToken,
  ensureMachineId,
  MACHINE_ID_FILE,
  proveDeviceIdentity,
  proveServerIdentity,
  TOKEN_FILE,
  TOKEN_HEADER,
} from "./access"
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
    profileDir: dataDir,
    channel: "alpha",
    packaged: false,
    resourcesDir: join(dataDir, "resources"),
    build: "test-build",
    version: "0.0.0-test",
    port: 0,
    install: null,
  })
  await runtime.start(() => undefined)
  token = ensureLocalToken(dataDir)
  server = await listen({
    port: 0,
    access: runtime.devices,
    localToken: token,
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
  expect(hello.capabilities).toEqual([
    "devices",
    "launch-ids",
    "answer-request",
    "machines",
    "screen-text",
  ])
  expect(await client.projects.list.query()).toEqual([])
  close()
})

test("Update machines automatically: on by default, saved by the server; no self-update for an app's server", async () => {
  const { client, close } = connect(token)
  expect(await client.server.updates.settings.query()).toEqual({
    autoUpdate: true,
    selfUpdate: false,
  })
  await client.server.updates.setAutoUpdate.mutate({ autoUpdate: false })
  expect((await client.server.updates.settings.query()).autoUpdate).toBe(false)
  await client.server.updates.setAutoUpdate.mutate({ autoUpdate: true })
  expect((await client.server.hello.query()).capabilities).not.toContain("server-update")
  close()
})

test("hello names this machine: a stable id from an owner-only file, host name, platform and arch", async () => {
  const { client, close } = connect(token)
  const hello = await client.server.hello.query()
  close()
  expect(hello.capabilities).toContain("machines")
  expect(hello).toMatchObject({
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch,
  })
  const path = join(dataDir, MACHINE_ID_FILE)
  expect(readFileSync(path, "utf8").trim()).toBe(hello.machineId)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  // The next server start reads the same id.
  expect(ensureMachineId(dataDir)).toBe(hello.machineId)
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
  expectWire(notebookCountSchema, await client.server.notebookCount.query())
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
  await closed
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

test("only the local device may create or revoke devices and stop the server", async () => {
  const local = connect(token)
  const created = await local.client.server.devices.create.mutate({ name: "Phone" })
  const phone = connect(created.token)
  const forbidden = async (call: Promise<unknown>) => {
    const error = await call.then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(TRPCClientError)
    expect((error as TRPCClientError<ServerRouter>).data?.code).toBe("FORBIDDEN")
  }
  await forbidden(phone.client.server.devices.create.mutate({ name: "Another" }))
  await forbidden(phone.client.server.devices.revoke.mutate({ id: created.device.id }))
  await forbidden(phone.client.server.stop.mutate({ stopAgents: false }))
  // Listing stays open to every device; nothing was added.
  expect(
    (await phone.client.server.devices.list.query()).map((device) => device.name),
  ).not.toContain("Another")
  phone.close()
  await local.client.server.devices.revoke.mutate({ id: created.device.id })
  local.close()
})

test("calls from a revoked device's open socket stop at once", async () => {
  const local = connect(token)
  const created = await local.client.server.devices.create.mutate({ name: "Tablet" })
  const tablet = new WebSocket(
    `ws://127.0.0.1:${server.port}/trpc?token=${encodeURIComponent(created.token)}`,
  )
  await new Promise((resolve, reject) => {
    tablet.once("open", resolve)
    tablet.once("error", reject)
  })
  tablet.on("error", () => {})
  // The tablet does not read, so it never sees the server close: it keeps sending.
  ;(tablet as unknown as { _socket: import("node:net").Socket })._socket.pause()
  await local.client.server.devices.revoke.mutate({ id: created.device.id })
  tablet.send(
    JSON.stringify({
      id: 1,
      method: "mutation",
      params: { path: "server.rememberQuitChoice", input: { choice: "background" } },
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect((await local.client.server.appSettings.query()).quitChoice).toBe("ask")
  tablet.terminate()
  local.close()
})

test("a broken devices.json entry or a failing token check never crashes the server", async () => {
  const { DeviceRegistry } = await import("./devices")
  const dir = mkdtempSync(join(tmpdir(), "pi-lab-devices-test-"))
  const { writeOwnerOnly } = await import("./access")
  writeOwnerOnly(
    join(dir, DEVICES_FILE),
    JSON.stringify([{ id: "short", name: "Old", createdAt: 1, revokedAt: null, tokenHash: "ab" }]),
  )
  const registry = new DeviceRegistry(dir)
  expect(registry.authenticate("some-token")).toBeNull()
  rmSync(dir, { recursive: true, force: true })

  const errors = vi.spyOn(console, "error").mockImplementation(() => {})
  const broken = await listen({
    port: 0,
    access: {
      authenticate: () => {
        throw new Error("token check failed")
      },
      track: () => () => {},
      proofKey: () => null,
      revoke: () => {},
    },
    localToken: token,
    testRoutes: false,
    createContext: () => runtime.createAppContext(),
    handleScheme: async () => new Response(null, { status: 404 }),
  })
  const status = await new Promise<number>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${broken.port}/trpc?token=x`)
    socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0))
    socket.on("error", () => resolve(-1))
  })
  expect(status).toBe(500)
  expect(errors).toHaveBeenCalled()
  errors.mockRestore()
  await broken.close()
})

test("an answer whose write fails leaves the request pending and returns the error", async () => {
  const { client, close } = connect(token)
  const outcome = runtime.notifications.notify({
    eventType: "agentInput",
    title: "Agent needs input",
    body: "Continue?",
    target: {
      type: "agent",
      projectId: "project",
      workspaceId: "workspace",
      sessionId: "no-such-session",
      agentId: "test-agent",
      origin: "project",
    },
  })
  const pendingIds = async (): Promise<string[]> => {
    const ids: string[] = []
    await new Promise<void>((resolve) => {
      const subscription = client.server.onNotification.subscribe(undefined, {
        onData: (message) => {
          if (message.type === "alert") ids.push(message.event.id)
        },
        onStarted: () =>
          setTimeout(() => {
            subscription.unsubscribe()
            resolve()
          }, 100),
      })
    })
    return ids
  }
  const [requestId] = await pendingIds()
  if (!requestId) throw new Error(`no pending request (${JSON.stringify(outcome)})`)
  await expect(
    client.server.answerRequest.mutate({ requestId, text: "yes" }),
  ).rejects.toBeInstanceOf(TRPCClientError)
  expect(await pendingIds()).toContain(requestId)
  runtime.notifications.take(requestId)
  close()
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

test("with alerts muted, a waiting agent reaches a device that connects later with no banner, and its answer clears it everywhere", async () => {
  const received = join(dataDir, "muted-answers.txt")
  const daemon = await runtime.createAppContext().getDaemonClient()
  const session = await daemon.spawn({
    command: process.execPath,
    args: [
      "-e",
      `process.stdout.write("Continue? [y/N] ");process.stdin.on("data",(d)=>require("node:fs").appendFileSync(${JSON.stringify(received)},d))`,
    ],
    env: { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: "1" },
  })
  const desktop = connect(token)
  await desktop.client.settings.updateNotifications.mutate({ muted: true })
  const desktopMessages: unknown[] = []
  await new Promise<void>((resolve) => {
    desktop.client.server.onNotification.subscribe(undefined, {
      onStarted: () => resolve(),
      onData: (message) => desktopMessages.push(message),
    })
  })
  runtime.notifications.notify({
    eventType: "agentInput",
    title: "Agent needs input",
    body: "Continue?",
    target: {
      type: "agent",
      projectId: "project",
      workspaceId: "workspace",
      sessionId: session.id,
      agentId: "test-agent",
      origin: "project",
    },
  })
  await vi.waitFor(() =>
    expect(desktopMessages).toEqual([expect.objectContaining({ type: "alert", banner: false })]),
  )

  // The phone connects after the agent started waiting.
  const phone = connect(token)
  const phoneMessages: Array<{ type: string; banner?: boolean; event?: { id: string } }> = []
  phone.client.server.onNotification.subscribe(undefined, {
    onData: (message) => phoneMessages.push(message),
  })
  await vi.waitFor(() => expect(phoneMessages).toHaveLength(1))
  expect(phoneMessages[0]).toMatchObject({ type: "alert", banner: false })
  const requestId = phoneMessages[0]?.event?.id
  if (!requestId) throw new Error("no pending request")

  expect(await phone.client.server.answerRequest.mutate({ requestId, text: "yes" })).toEqual({
    status: "accepted",
  })
  await vi.waitFor(() => expect(desktopMessages).toContainEqual({ type: "cleared", id: requestId }))
  await vi.waitFor(() => expect(phoneMessages).toContainEqual({ type: "cleared", id: requestId }))
  await vi.waitFor(() => expect(readFileSync(received, "utf8")).toContain("yes"))

  await desktop.client.settings.updateNotifications.mutate({ muted: false })
  await daemon.kill(session.id)
  desktop.close()
  phone.close()
})

test("with alerts muted, an information event reaches a device that connects later through the history", async () => {
  const desktop = connect(token)
  await desktop.client.settings.updateNotifications.mutate({ muted: true })
  runtime.notifications.notify({
    eventType: "agentTurnCompletion",
    title: "Agent finished its turn",
    body: "Muted info event",
    target: {
      type: "agent",
      projectId: "project",
      workspaceId: "workspace",
      sessionId: "muted-info-session",
      agentId: "test-agent",
      origin: "project",
    },
  })
  const phone = connect(token)
  const history = await phone.client.server.notificationHistory.query()
  expect(history[0]).toMatchObject({ kind: "info", request: { body: "Muted info event" } })
  await desktop.client.settings.updateNotifications.mutate({ muted: false })
  desktop.close()
  phone.close()
})

test("GET /identity proves the server holds the token without sending it, new for each nonce", async () => {
  expect(await proveServerIdentity(server.port, token)).toBe(true)
  // A client with another token (another data folder) does not accept this server.
  expect(await proveServerIdentity(server.port, "x".repeat(43))).toBe(false)
  const answer = async (nonce: string) =>
    (
      await fetch(`http://127.0.0.1:${server.port}/identity?nonce=${nonce}`)
    ).json() as Promise<object>
  const first = await answer("a".repeat(32))
  expect(Object.keys(first)).toEqual(["proof"])
  expect(JSON.stringify(first)).not.toContain(token)
  expect(await answer("b".repeat(32))).not.toEqual(first)
  // No nonce, or one that is not hex, gets no proof.
  expect((await fetch(`http://127.0.0.1:${server.port}/identity`)).status).toBe(400)
  expect((await fetch(`http://127.0.0.1:${server.port}/identity?nonce=zz`)).status).toBe(400)
})

test("GET /identity with a device id proves the server knows that device's token; revoked or unknown devices get no proof", async () => {
  const local = connect(token)
  const created = await local.client.server.devices.create.mutate({ name: "Remote laptop" })
  expect(await proveDeviceIdentity(server.port, created.device.id, created.token)).toBe(true)
  // Another token for the same id, or an unknown id, is not accepted.
  expect(await proveDeviceIdentity(server.port, created.device.id, "y".repeat(43))).toBe(false)
  expect(await proveDeviceIdentity(server.port, "no-such-device", created.token)).toBe(false)
  await local.client.server.devices.revoke.mutate({ id: created.device.id })
  expect(await proveDeviceIdentity(server.port, created.device.id, created.token)).toBe(false)
  local.close()
})

test("POST /device/revoke revokes the device whose token it carries; the local token is refused", async () => {
  const local = connect(token)
  const created = await local.client.server.devices.create.mutate({ name: "Leaving laptop" })
  const revokeSelf = (presented: string) =>
    fetch(`http://127.0.0.1:${server.port}/device/revoke`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: presented },
    })
  expect((await revokeSelf(created.token)).status).toBe(204)
  expect(await upgradeStatus(created.token)).toBe(401)
  const listed = (await local.client.server.devices.list.query()).find(
    (device) => device.id === created.device.id,
  )
  expect(listed?.revokedAt).toEqual(expect.any(Number))
  expect((await revokeSelf(token)).status).toBe(403)
  expect(await upgradeStatus(token)).toBe(101)
  local.close()
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

/** A git repo opened as a project on this server; returns its main workspace id and folder. */
async function projectWithFiles(): Promise<{ workspaceId: string; dir: string }> {
  const { execFileSync } = await import("node:child_process")
  const { mkdirSync, realpathSync, writeFileSync } = await import("node:fs")
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-lab-transfer-repo-")))
  execFileSync("git", ["init", "-q", "-b", "main", dir])
  writeFileSync(join(dir, "notes.txt"), "old notes\n")
  mkdirSync(join(dir, "data", "deep"), { recursive: true })
  writeFileSync(join(dir, "data", "a.csv"), "x,y\n1,2\n")
  writeFileSync(join(dir, "data", "deep", "b.txt"), "ünïcode\n")
  const { client, close } = connect(token)
  const project = await client.projects.open.mutate({ path: dir })
  const workspace = await client.workspaces.ensureMain.mutate({ projectId: project.id })
  close()
  return { workspaceId: workspace.id, dir }
}

function transferUrl(kind: "download" | "upload", query: Record<string, string>): string {
  return `http://127.0.0.1:${server.port}/files/${kind}?${new URLSearchParams(query)}`
}

test("GET /files/download streams a file, and a folder as a tar archive; paths outside the project are refused", async () => {
  const { execFileSync } = await import("node:child_process")
  const { workspaceId } = await projectWithFiles()
  const headers = { [TOKEN_HEADER]: token }
  const file = await fetch(transferUrl("download", { workspaceId, relPath: "notes.txt" }), {
    headers,
  })
  expect(file.status).toBe(200)
  expect(file.headers.get("x-pi-lab-entry")).toBe("file")
  expect(await file.text()).toBe("old notes\n")

  const folder = await fetch(transferUrl("download", { workspaceId, relPath: "data" }), {
    headers,
  })
  expect(folder.status).toBe(200)
  expect(folder.headers.get("x-pi-lab-entry")).toBe("dir")
  const out = mkdtempSync(join(tmpdir(), "pi-lab-transfer-out-"))
  execFileSync("tar", ["-xf", "-", "-C", out], {
    input: Buffer.from(await folder.arrayBuffer()),
  })
  expect(readFileSync(join(out, "a.csv"), "utf8")).toBe("x,y\n1,2\n")
  expect(readFileSync(join(out, "deep", "b.txt"), "utf8")).toBe("ünïcode\n")
  rmSync(out, { recursive: true, force: true })

  const outside = await fetch(transferUrl("download", { workspaceId, relPath: "../x" }), {
    headers,
  })
  expect(outside.status).toBe(403)
  const missing = await fetch(transferUrl("download", { workspaceId, relPath: "none.txt" }), {
    headers,
  })
  expect(missing.status).toBe(404)
  expect((await fetch(transferUrl("download", { workspaceId, relPath: "notes.txt" }))).status).toBe(
    401,
  )
})

test("PUT /files/upload writes a file (folders made as needed), refuses to replace one unless asked", async () => {
  const { workspaceId, dir } = await projectWithFiles()
  const put = (relPath: string, body: string, replace: "0" | "1") =>
    fetch(transferUrl("upload", { workspaceId, relPath, replace }), {
      method: "PUT",
      headers: { [TOKEN_HEADER]: token },
      body,
    })
  expect((await put("new/sub/fresh.txt", "fresh\n", "0")).status).toBe(204)
  expect(readFileSync(join(dir, "new", "sub", "fresh.txt"), "utf8")).toBe("fresh\n")
  expect((await put("notes.txt", "new notes\n", "0")).status).toBe(409)
  expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("old notes\n")
  expect((await put("notes.txt", "new notes\n", "1")).status).toBe(204)
  expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("new notes\n")
  expect((await put("../escape.txt", "x", "1")).status).toBe(403)
  // A symlink inside the workspace to a folder outside: the refused upload makes no folders there.
  const { existsSync, symlinkSync } = await import("node:fs")
  const outside = mkdtempSync(join(tmpdir(), "pi-lab-transfer-outside-"))
  symlinkSync(outside, join(dir, "link"))
  expect((await put("link/made/x.txt", "x", "1")).status).toBe(403)
  expect(existsSync(join(outside, "made"))).toBe(false)
  rmSync(outside, { recursive: true, force: true })
})

test("an interrupted upload leaves the old file intact; calls stay responsive during large transfers", async () => {
  const { request } = await import("node:http")
  const { readdirSync, writeFileSync } = await import("node:fs")
  const { workspaceId, dir } = await projectWithFiles()
  writeFileSync(join(dir, "big.bin"), Buffer.alloc(64 * 1024 * 1024, 7))
  const { client, close } = connect(token)

  // A large download whose reader stops reading: the server waits on the socket.
  const download = await fetch(transferUrl("download", { workspaceId, relPath: "big.bin" }), {
    headers: { [TOKEN_HEADER]: token },
  })
  expect(download.status).toBe(200)

  // An upload that sends part of a file, then stops.
  const upload = request(
    transferUrl("upload", { workspaceId, relPath: "notes.txt", replace: "1" }),
    {
      method: "PUT",
      headers: { [TOKEN_HEADER]: token },
    },
  )
  upload.on("error", () => undefined)
  upload.write(Buffer.alloc(8 * 1024 * 1024, 1))

  // Editing a routine and answering an agent go over the same server: an ordinary call answers fast.
  const started = Date.now()
  await client.projects.list.query()
  await client.settings.get.query()
  expect(Date.now() - started).toBeLessThan(1_000)

  upload.destroy()
  await download.body?.cancel()
  await vi.waitFor(() =>
    expect(readdirSync(dir).filter((name) => name.includes(".pi-lab-upload-"))).toEqual([]),
  )
  expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("old notes\n")
  close()
})
