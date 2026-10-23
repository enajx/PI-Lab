import { describe, expect, it } from "vitest"
import { trayProjectSnapshot } from "./projectSnapshot"

describe("background tray projects", () => {
  it("shows working and waiting projects once, with working taking priority", () => {
    const snapshot = trayProjectSnapshot(
      [
        { id: "a", name: "Alpha", lastActivityAt: 0 },
        { id: "b", name: "Beta", lastActivityAt: 0 },
        { id: "c", name: "Closed", lastActivityAt: 0 },
      ],
      [
        { projectId: "a", state: "waiting" },
        { projectId: "a", state: "working" },
        { projectId: "b", state: "waiting" },
        { projectId: "c", state: "exited" },
      ],
      10 * 86400000,
    )
    expect(snapshot.projects).toEqual([
      { id: "a", name: "Alpha", state: "working" },
      { id: "b", name: "Beta", state: "waiting" },
    ])
  })
})

// Recent opened projects and completed agent work are both supplied by the durable runtime query.
it("includes recent inactive projects through the exact seven-day boundary", () => {
  const now = 20 * 86400000
  expect(
    trayProjectSnapshot(
      [
        { id: "recent", name: "Recent", lastActivityAt: now - 1 },
        { id: "edge", name: "Boundary", lastActivityAt: now - 7 * 86400000 },
        { id: "old", name: "Old", lastActivityAt: now - 7 * 86400000 - 1 },
      ],
      [],
      now,
    ).projects,
  ).toEqual([
    { id: "recent", name: "Recent", state: "idle" },
    { id: "edge", name: "Boundary", state: "idle" },
  ])
})
