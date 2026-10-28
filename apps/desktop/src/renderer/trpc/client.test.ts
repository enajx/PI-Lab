import type { Operation } from "@trpc/client"
import type { TRPCResponseMessage } from "@trpc/server/rpc"
import superjson from "superjson"
import { afterEach, expect, test, vi } from "vitest"
import { createPiLabTrpcClient } from "./client"

afterEach(() => vi.unstubAllGlobals())

/** Real client/link behavior with only the Electron transport mocked. */
test("independent clients receive their own replies when local request counters overlap", async () => {
  const requests: Operation[] = []
  const listeners: Array<(reply: TRPCResponseMessage) => void> = []
  vi.stubGlobal("electronTRPC", {
    sendMessage: (message: { method: string; operation?: Operation }) => {
      if (message.operation) requests.push(message.operation)
    },
    onMessage: (listener: (reply: TRPCResponseMessage) => void) => listeners.push(listener),
  })
  const health = createPiLabTrpcClient().health.ping.query()
  const spawn = createPiLabTrpcClient().terminal.spawn.mutate({ cols: 80, rows: 24 })
  expect(requests).toHaveLength(2)
  for (const request of requests) {
    const data =
      request.path === "health.ping"
        ? { ok: true, echo: "pong", at: 1 }
        : { sessionId: "the-terminal-session" }
    const reply: TRPCResponseMessage = {
      id: request.id,
      result: { type: "data", data: superjson.serialize(data) },
    }
    for (const listener of listeners) listener(reply)
  }
  expect(await health).toMatchObject({ ok: true, echo: "pong" })
  expect(await spawn).toEqual({ sessionId: "the-terminal-session" })
})
