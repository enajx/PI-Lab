import type { AddressInfo } from "node:net"
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client"
import { initTRPC, TRPCError } from "@trpc/server"
import { applyWSSHandler } from "@trpc/server/adapters/ws"
import { afterEach, expect, test } from "vitest"
import { WebSocket, WebSocketServer } from "ws"
import { z } from "zod"
import { startOnce } from "./launch"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/**
 * A small real tRPC server over a real WebSocket (not the PI Lab server): the
 * first `start` runs and then the socket drops before its reply is sent.
 */
async function lossyServer() {
  const seen: string[] = []
  const t = initTRPC.create()
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  const appRouter = t.router({
    start: t.procedure.input(z.object({ launchId: z.string() })).mutation(async ({ input }) => {
      seen.push(input.launchId)
      if (seen.length === 1) {
        for (const socket of wss.clients) socket.terminate()
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return { sessionId: `session-for-${input.launchId}` }
    }),
    refuse: t.procedure.input(z.object({ launchId: z.string() })).mutation(({ input }) => {
      seen.push(input.launchId)
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No agent" })
    }),
  })
  const handler = applyWSSHandler({ wss, router: appRouter })
  await new Promise((resolve) => wss.once("listening", resolve))
  const socket = createWSClient({
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    retryDelayMs: () => 10,
  })
  cleanups.push(() => {
    socket.close()
    handler.broadcastReconnectNotification()
    wss.close()
  })
  return {
    seen,
    client: createTRPCClient<typeof appRouter>({ links: [wsLink({ client: socket })] }),
  }
}

test("a start whose reply is lost is sent again with the same launch ID", async () => {
  const { seen, client } = await lossyServer()
  const result = await startOnce((launchId) => client.start.mutate({ launchId }))
  expect(seen).toHaveLength(2)
  expect(seen[1]).toBe(seen[0])
  expect(result).toEqual({ sessionId: `session-for-${seen[0]}` })
})

test("a start the server refused is not sent again", async () => {
  const { seen, client } = await lossyServer()
  await expect(startOnce((launchId) => client.refuse.mutate({ launchId }))).rejects.toThrow(
    "No agent",
  )
  expect(seen).toHaveLength(1)
})
