import { describe, expect, test } from "vitest"
import { deriveProjectStates } from "./deriveProjectState"

describe("deriveProjectStates", () => {
  test("ignores exited sessions and isolates each project", () => {
    const states = deriveProjectStates([
      { projectId: "a", state: "exited" },
      { projectId: "b", state: "working" },
      { projectId: "c", state: "waiting" },
    ])
    expect(states.get("a") ?? "idle").toBe("idle")
    expect(states.get("b")).toBe("active")
    expect(states.get("c")).toBe("attention")
  })

  test("waiting takes priority over working in either order", () => {
    const working = { projectId: "a", state: "working" } as const
    const waiting = { projectId: "a", state: "waiting" } as const
    expect(deriveProjectStates([working, waiting]).get("a")).toBe("attention")
    expect(deriveProjectStates([waiting, working]).get("a")).toBe("attention")
  })
})
