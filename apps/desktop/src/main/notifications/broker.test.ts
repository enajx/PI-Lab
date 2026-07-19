import { describe, expect, test } from "vitest"
import { EventBroker } from "./broker"

describe("EventBroker", () => {
  test("replays activation and sound events emitted before the renderer subscribes", () => {
    const broker = new EventBroker<string>()
    broker.publish("before-renderer")
    const received: string[] = []

    broker.subscribe((event) => received.push(event))
    broker.publish("live")

    expect(received).toEqual(["before-renderer", "live"])
  })
})
