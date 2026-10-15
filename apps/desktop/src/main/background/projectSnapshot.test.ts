import { describe, expect, it } from "vitest"
import { trayProjectSnapshot } from "./projectSnapshot"

describe("background tray projects", () => {
  it("shows working and waiting projects once, with working taking priority", () => {
    const snapshot = trayProjectSnapshot(
      [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
        { id: "c", name: "Closed" },
      ],
      [
        { projectId: "a", state: "waiting" },
        { projectId: "a", state: "working" },
        { projectId: "b", state: "waiting" },
        { projectId: "c", state: "exited" },
      ],
    )
    expect(snapshot.projects).toEqual([
      { id: "a", name: "Alpha", state: "working" },
      { id: "b", name: "Beta", state: "waiting" },
    ])
  })
})
