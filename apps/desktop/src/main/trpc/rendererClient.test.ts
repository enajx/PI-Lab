import { createServer, type Server } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { initTRPC } from "@trpc/server"
import { applyWSSHandler } from "@trpc/server/adapters/ws"
import { observable } from "@trpc/server/observable"
import type { TRPCResponseMessage } from "@trpc/server/rpc"
import superjson from "superjson"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import { z } from "zod"
import { createDocumentTrpcBridge } from "../../preload/trpcBridge"
import { createPiLabTrpcClient, serverSocketUrl } from "../../renderer/trpc/client"

/**
 * The renderer's real tRPC client in one document: a real IPC handler with only
 * Electron's transport events substituted (as in ipcIsolation.test.ts), and a
 * real tRPC WebSocket server standing in for the PI Lab server.
 */

type IpcListener = (event: unknown, message: unknown) => void
const electron = { listener: undefined as IpcListener | undefined }
const nodeRequire = createRequire(import.meta.url)

function installedHandler(): typeof import("trpc-electron/main") {
  const module = nodeRequire("node:module") as {
    _load: (name: string, parent: unknown, isMain: boolean) => unknown
  }
  const load = module._load
  module._load = (name, parent, isMain) =>
    name === "electron"
      ? {
          ipcMain: {
            on: (_channel: string, listener: IpcListener) => {
              electron.listener = listener
            },
          },
          contextBridge: {},
          ipcRenderer: {},
        }
      : load(name, parent, isMain)
  try {
    return nodeRequire("trpc-electron/main") as typeof import("trpc-electron/main")
  } finally {
    module._load = load
  }
}

const t = initTRPC.create({ transformer: superjson })
const emitters = new Set<(chunk: string) => void>()
const serverRouter = t.router({
  terminal: t.router({
    onData: t.procedure.subscription(() =>
      observable<string>((emit) => {
        const send = (chunk: string) => emit.next(chunk)
        emitters.add(send)
        return () => emitters.delete(send)
      }),
    ),
    write: t.procedure
      .input(z.object({ data: z.string() }))
      .mutation(({ input }) => ({ wrote: input.data })),
  }),
})

let http: Server
let wss: WebSocketServer
/** Preload listeners registered through the document bridge. */
let preloadListeners = 0

beforeAll(async () => {
  wss = new WebSocketServer({ noServer: true })
  applyWSSHandler({ wss, router: serverRouter })
  http = createServer()
  http.on("upgrade", (request, socket, head) =>
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request)),
  )
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`
  const desktopRouter = t.router({
    desktop: t.router({ serverEndpoint: t.procedure.query(() => ({ url })) }),
  })
  installedHandler().createIPCHandler({ router: desktopRouter })
  const receivers: Array<(response: TRPCResponseMessage) => void> = []
  ;(globalThis as { electronTRPC?: unknown }).electronTRPC = createDocumentTrpcBridge("doc", {
    send(message) {
      const listener = electron.listener
      if (!listener) throw new Error("Real IPC handler has not registered")
      listener(
        {
          sender: { id: 1, isDestroyed: () => false },
          senderFrame: { routingId: 1 },
          reply: (_channel: string, response: TRPCResponseMessage) => {
            for (const receive of [...receivers]) receive(response)
          },
        },
        message,
      )
    },
    onMessage(receive) {
      preloadListeners++
      receivers.push(receive)
    },
  })
})

afterAll(async () => {
  for (const client of wss.clients) client.terminate()
  wss.close()
  await new Promise<void>((resolve) => http.close(() => resolve()))
})

type FixtureClient = ReturnType<typeof import("@trpc/client").createTRPCClient<typeof serverRouter>>

test("repeated server URL lookups reuse one IPC client and add no preload listeners", async () => {
  const before = preloadListeners
  const urls = [await serverSocketUrl(), await serverSocketUrl(), await serverSocketUrl()]
  expect(new Set(urls).size).toBe(1)
  expect(preloadListeners - before).toBeLessThanOrEqual(1)
  const after = preloadListeners
  await serverSocketUrl()
  expect(preloadListeners).toBe(after)
})

test("two clients in one document share the socket without mixing up a subscription and a mutation", async () => {
  // The app's client and a Quick Editor terminal's own client.
  const app = createPiLabTrpcClient() as unknown as FixtureClient
  const terminal = createPiLabTrpcClient() as unknown as FixtureClient
  const received: string[] = []
  const subscription = app.terminal.onData.subscribe(undefined, {
    onData: (chunk) => received.push(chunk),
  })
  await vi.waitFor(() => expect(emitters.size).toBe(1))
  expect(await terminal.terminal.write.mutate({ data: "a" })).toEqual({ wrote: "a" })
  expect(await terminal.terminal.write.mutate({ data: "b" })).toEqual({ wrote: "b" })
  for (const emit of emitters) emit("live")
  await vi.waitFor(() => expect(received).toEqual(["live"]))
  subscription.unsubscribe()
})
