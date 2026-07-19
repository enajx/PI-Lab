import { describe, expect, test } from "vitest"
import { readSetupGateMode, shouldRedirectToSetup } from "./firstRunRoute"

describe("first-run setup gate", () => {
  test("production and dedicated first-run tests honor the SQLite completion marker", () => {
    expect(readSetupGateMode("")).toBe("honor")
    expect(shouldRedirectToSetup(false, "/", "honor")).toBe(true)
    expect(shouldRedirectToSetup(true, "/", "honor")).toBe(false)
  })

  test("the test-only bypass preserves existing fresh-data E2Es", () => {
    expect(readSetupGateMode("?setup=skip")).toBe("bypass")
    expect(shouldRedirectToSetup(false, "/", "bypass")).toBe(false)
  })

  test("manual setup remains accessible regardless of marker or bypass", () => {
    expect(shouldRedirectToSetup(false, "/setup", "honor")).toBe(false)
    expect(shouldRedirectToSetup(true, "/setup", "bypass")).toBe(false)
  })
})
