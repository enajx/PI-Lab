import type { Operation } from "@trpc/client"
import { initTRPC } from "@trpc/server"
import type { TRPCResponseMessage } from "@trpc/server/rpc"
import superjson from "superjson"
import { afterEach, expect, test, vi } from "vitest"
import { z } from "zod"
import { isDesktopPath } from "../../shared/desktopPaths"
import { createIpcClient } from "./client"

afterEach(() => vi.unstubAllGlobals())

const t = initTRPC.create({ transformer: superjson })
const fixtureRouter = t.router({
  health: t.router({ ping: t.procedure.query(() => ({ ok: true, echo: "pong", at: 1 })) }),
  terminal: t.router({
    spawn: t.procedure
      .input(z.object({ cols: z.number(), rows: z.number() }))
      .mutation(() => ({ sessionId: "the-terminal-session" })),
  }),
})
type FixtureRouter = typeof fixtureRouter

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
  const health = createIpcClient<FixtureRouter>().health.ping.query()
  const spawn = createIpcClient<FixtureRouter>().terminal.spawn.mutate({ cols: 80, rows: 24 })
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

test("desktop paths go over IPC and every other path goes to the server", () => {
  for (const path of [
    "system.openFolder",
    "notifications.playSound",
    "desktop.serverEndpoint",
    "files.reveal",
    "dictation.status",
  ])
    expect(isDesktopPath(path), path).toBe(true)
  for (const path of ["projects.list", "terminal.spawn", "files.read", "health.ping"])
    expect(isDesktopPath(path), path).toBe(false)
})
