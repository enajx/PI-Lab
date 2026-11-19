// The output scheduler on its own (no sockets): which stream sends next.
// The flow control end to end runs in server/terminalConnection.test.ts.

import { expect, test } from "vitest"
import { ConnectionFlow, type FlowItem, OUTPUT_CHUNK_BYTES } from "./outputFlow"

const KiB = 1024

function data(offset: number, length: number): FlowItem {
  return {
    kind: "data",
    sessionId: "s",
    generation: "g",
    offset,
    bytes: Buffer.alloc(length, 0x61),
  }
}

test("typing priority: the terminal typed in within the last 3 s sends before other terminals' bulk output, past the connection cap", () => {
  const flow = new ConnectionFlow()
  const delivered: string[] = []
  const typedAt = new Map<string, number>()
  const open = (name: string) =>
    flow.open({
      streamId: name,
      sessionId: name,
      holdSkip: false,
      typedAt: () => typedAt.get(name) ?? null,
      deliver: () => delivered.push(name),
      requestSnapshot: () => {},
    })
  const floods = ["a", "b", "c", "d"].map((name) => ({ name, stream: open(name) }))
  const quiet = open("quiet")
  // Each flood has more queued than the connection cap lets out.
  for (const { stream } of floods) {
    for (let offset = 0; offset < 200 * KiB; offset += OUTPUT_CHUNK_BYTES)
      stream.push(data(offset, OUTPUT_CHUNK_BYTES))
  }
  expect(flow.inFlightBytes).toBeGreaterThanOrEqual(flow.capBytes)
  delivered.length = 0

  // The user types in the quiet terminal: its echo goes out at once, past the cap.
  typedAt.set("quiet", Date.now())
  quiet.push(data(0, 1))
  expect(delivered).toEqual(["quiet"])
  // The floods still wait for acks.
  for (const { stream } of floods) stream.push(data(200 * KiB, OUTPUT_CHUNK_BYTES))
  expect(delivered).toEqual(["quiet"])

  // Without recent typing, the same terminal waits behind the cap, then for its turn.
  typedAt.set("quiet", Date.now() - 3_100)
  delivered.length = 0
  quiet.push(data(1, 1))
  expect(delivered).toEqual([])
  flow.ack("b", OUTPUT_CHUNK_BYTES, false)
  expect(delivered[0]).not.toBe("quiet")
})
