import { createRequire } from "node:module"
import type { Operation } from "@trpc/client"
import { initTRPC, TRPCError } from "@trpc/server"
import { observable } from "@trpc/server/observable"
import type { TRPCResponseMessage } from "@trpc/server/rpc"
import superjson from "superjson"
import { afterEach, expect, test, vi } from "vitest"
import { z } from "zod"
import { createDocumentTrpcBridge } from "../../preload/trpcBridge"
import { createPiLabTrpcClient } from "../../renderer/trpc/client"

type IpcListener = (event: unknown, message: unknown) => void
const electron = { listener: undefined as IpcListener | undefined }
const nodeRequire = createRequire(import.meta.url)

/** Load the real CommonJS handler while substituting only its Electron event transport. */
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
const { createIPCHandler } = installedHandler()

type Port = Parameters<typeof createDocumentTrpcBridge>[1]
type WireRequest = Parameters<Port["send"]>[0]
type ResponseListener = (response: TRPCResponseMessage) => void
type RendererGlobal = typeof globalThis & {
  electronTRPC?: ReturnType<typeof createDocumentTrpcBridge>
}
const global = globalThis as RendererGlobal

afterEach(() => {
  delete global.electronTRPC
  electron.listener = undefined
})

/** A real installed IPC handler/router with only Electron's transport events substituted. */
function harness() {
  const t = initTRPC.create({ transformer: superjson })
  const gates = new Map<string, Promise<void>>()
  const stopped = vi.fn()
  const router = t.router({
    health: t.router({
      ping: t.procedure.input(z.object({ message: z.string() })).query(async ({ input }) => {
        await gates.get(input.message)
        return { ok: true as const, echo: input.message, at: 123 }
      }),
    }),
    terminal: t.router({
      spawn: t.procedure
        .input(z.object({ command: z.string().optional() }))
        .mutation(async ({ input }) => {
          await gates.get("spawn")
          if (input.command === "reject")
            throw new TRPCError({ code: "BAD_REQUEST", message: "Fixture spawn rejected" })
          return { sessionId: "scoped-terminal" }
        }),
      onData: t.procedure.input(z.object({ sessionId: z.string() })).subscription(() =>
        observable<{ type: "data"; chunk: string }>((emit) => {
          emit.next({ type: "data", chunk: "scoped output" })
          return stopped
        }),
      ),
    }),
  })
  createIPCHandler({ router })
  let receivers: ResponseListener[] = []
  const replies: TRPCResponseMessage[] = []
  const port: Port = {
    send(message: WireRequest): void {
      const listener = electron.listener
      if (!listener) throw new Error("Real IPC handler has not registered")
      listener(
        {
          sender: { id: 1, isDestroyed: () => false },
          senderFrame: { routingId: 1 },
          reply: (_channel: string, response: TRPCResponseMessage) => {
            replies.push(response)
            for (const receive of [...receivers]) receive(response)
          },
        },
        message,
      )
    },
    onMessage(receive: ResponseListener): void {
      receivers.push(receive)
    },
  }
  return {
    port,
    replies,
    stopped,
    navigate(): void {
      receivers = []
    },
    pause(name: string): () => void {
      let release: (() => void) | undefined
      gates.set(
        name,
        new Promise<void>((resolve) => {
          release = resolve
        }),
      )
      return () => {
        if (!release) throw new Error("Request gate was not initialized")
        release()
      }
    },
  }
}

/** Real clients and server: matching per-client counters must not exchange result data. */
test("independent clients keep simultaneous query and terminal spawn replies separate", async () => {
  const ipc = harness()
  const releaseHealth = ipc.pause("health")
  const releaseSpawn = ipc.pause("spawn")
  global.electronTRPC = createDocumentTrpcBridge("document-a", ipc.port)
  const first = createPiLabTrpcClient()
  const second = createPiLabTrpcClient()
  const health = first.health.ping.query({ message: "health" })
  const spawn = second.terminal.spawn.mutate({ cols: 80, rows: 24 })
  releaseHealth()
  expect(await health).toEqual({ ok: true, echo: "health", at: 123 })
  releaseSpawn()
  expect(await spawn).toEqual({ sessionId: "scoped-terminal" })
})

/** Real upstream observable handling: the scoped stop reaches the owning server subscription. */
test("subscription results and unsubscribe use the same isolated request identity", async () => {
  const ipc = harness()
  global.electronTRPC = createDocumentTrpcBridge("document-subscription", ipc.port)
  const events: unknown[] = []
  const subscription = createPiLabTrpcClient().terminal.onData.subscribe(
    { sessionId: "scoped-terminal" },
    {
      onData: (event) => events.push(event),
    },
  )
  await vi.waitFor(() => expect(events).toEqual([{ type: "data", chunk: "scoped output" }]))
  subscription.unsubscribe()
  await vi.waitFor(() => expect(ipc.stopped).toHaveBeenCalledTimes(1))
})

/** Error serialization and routing stay intact while another client's query remains pending. */
test("a server error reaches only its owning client", async () => {
  const ipc = harness()
  const releaseHealth = ipc.pause("health")
  global.electronTRPC = createDocumentTrpcBridge("document-error", ipc.port)
  const health = createPiLabTrpcClient().health.ping.query({ message: "health" })
  await expect(
    createPiLabTrpcClient().terminal.spawn.mutate({ command: "reject", cols: 80, rows: 24 }),
  ).rejects.toMatchObject({
    name: "TRPCClientError",
    message: "Fixture spawn rejected",
  })
  releaseHealth()
  expect(await health).toEqual({ ok: true, echo: "health", at: 123 })
})

/** Reuse numeric ID 1 after navigation; the old delayed server response must stay in its old document. */
test("a delayed reply from a previous document cannot satisfy a new request with the same number", async () => {
  const ipc = harness()
  const releaseOld = ipc.pause("old")
  const releaseNew = ipc.pause("new")
  const operation = (message: string): Operation => ({
    id: 1,
    type: "query",
    path: "health.ping",
    input: superjson.serialize({ message }),
    context: {},
    signal: null,
  })
  const oldBridge = createDocumentTrpcBridge("old-document", ipc.port)
  oldBridge.onMessage(() => {})
  oldBridge.sendMessage({ method: "request", operation: operation("old") })
  ipc.navigate()
  const newBridge = createDocumentTrpcBridge("new-document", ipc.port)
  const received: TRPCResponseMessage[] = []
  newBridge.onMessage((response) => received.push(response))
  newBridge.sendMessage({ method: "request", operation: operation("new") })
  releaseOld()
  await vi.waitFor(() => expect(ipc.replies).toHaveLength(1))
  expect(received).toEqual([])
  releaseNew()
  await vi.waitFor(() => expect(received).toHaveLength(1))
  const response = received[0]
  if (!response || !("result" in response) || !("data" in response.result))
    throw new Error("Expected the new document's successful query response")
  expect(
    superjson.deserialize(response.result.data as Parameters<typeof superjson.deserialize>[0]),
  ).toEqual({ ok: true, echo: "new", at: 123 })
})
