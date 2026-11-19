import { describe, expect, it } from "vitest"
import { sessionEnded } from "./sessionEnded"

describe("session ended", () => {
  it("reads the server's unknown-session error as an ended session", () => {
    expect(
      sessionEnded(
        "no session 1b77c232-1632-4990-b1ce-c6e25458980b",
        "1b77c232-1632-4990-b1ce-c6e25458980b",
      ),
    ).toBe(true)
  })

  it("leaves other errors and other sessions alone", () => {
    expect(sessionEnded("socket closed", "s1")).toBe(false)
    expect(sessionEnded("no session s2", "s1")).toBe(false)
  })
})
