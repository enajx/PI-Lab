import { describe, expect, it } from "vitest"
import { MessageOutbox } from "./outbox"

describe("message outbox", () => {
  it("resends a failed message with the same message ID, and a new message gets a new ID", async () => {
    const seen: string[] = []
    let fail = true
    const send = async (input: { messageId: string; text: string }) => {
      seen.push(input.messageId)
      if (fail) throw new Error("lost reply")
    }
    let next = 0
    const outbox = new MessageOutbox(() => `m${++next}`)
    await expect(outbox.send("hello", send)).rejects.toThrow("lost reply")
    fail = false
    await outbox.send("hello", send)
    await outbox.send("again", send)
    expect(seen).toEqual(["m1", "m1", "m2"])
  })
})
