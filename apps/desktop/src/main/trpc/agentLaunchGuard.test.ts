import { expect, test } from "vitest"
import { withAgentLaunchGuard } from "./agentLaunchGuard"

test("only overlapping same-project setup waits, and failure releases the next launch", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const events: string[] = []
  const start = (projectId: string, launch: () => Promise<void>) =>
    withAgentLaunchGuard({ projectId, gitAvailable: true, liveAgentCount: () => 0, launch })
  const first = start("project-a", async () => {
    events.push("first")
    await gate
    throw new Error("launch failed")
  })
  const failure = expect(first).rejects.toThrow("launch failed")
  const second = start("project-a", async () => {
    events.push("second")
  })
  await start("project-b", async () => {
    events.push("independent")
  })
  expect(events).toEqual(["first", "independent"])
  release()
  await failure
  await second
  expect(events).toEqual(["first", "independent", "second"])
})
