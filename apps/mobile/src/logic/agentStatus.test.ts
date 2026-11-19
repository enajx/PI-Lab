import { describe, expect, it } from "vitest"
import { agentStatus } from "./agentStatus"

describe("agent status label", () => {
  it("tells an agent that needs input apart from one that finished its turn", () => {
    expect(agentStatus({ state: "working" })).toEqual({ label: "Working", tone: "working" })
    for (const reason of ["permission", "question", "initial-prompt"] as const) {
      expect(agentStatus({ state: "waiting", waitingReason: reason })).toEqual({
        label: "Needs input",
        tone: "needs-input",
      })
    }
    expect(agentStatus({ state: "waiting", waitingReason: "turn-complete" })).toEqual({
      label: "Finished",
      tone: "finished",
    })
    expect(agentStatus({ state: "waiting", waitingReason: "idle" })).toEqual({
      label: "Idle",
      tone: "idle",
    })
  })

  it("shows a plain wait when the server sends no reason (an older server)", () => {
    expect(agentStatus({ state: "waiting" })).toEqual({ label: "Waiting", tone: "needs-input" })
  })
})
