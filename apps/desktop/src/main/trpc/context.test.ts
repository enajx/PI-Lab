import { BUILTIN_AGENTS } from "@pi-lab/shared"
import { describe, expect, test } from "vitest"
import { buildAgentCatalog, TEST_AGENT_ID } from "./context"

describe("buildAgentCatalog", () => {
  test("normal mode is exactly the built-ins (no test agent leaks in)", () => {
    const catalog = buildAgentCatalog(false)
    expect(catalog).toEqual(BUILTIN_AGENTS)
    expect(catalog.some((agent) => agent.id === TEST_AGENT_ID)).toBe(false)
  })

  test("test mode appends the deterministic test agent after the built-ins", () => {
    const catalog = buildAgentCatalog(true)
    // Built-ins are preserved, in order, ahead of the test agent.
    expect(catalog.slice(0, BUILTIN_AGENTS.length)).toEqual(BUILTIN_AGENTS)
    const testAgent = catalog.find((agent) => agent.id === TEST_AGENT_ID)
    expect(testAgent).toBeDefined()
    // It runs a local binary with a marker-emitting one-liner — no network/creds.
    expect(testAgent?.command).toBe(process.execPath)
    expect(testAgent?.defaultArgs?.join(" ")).toContain("AGENT-UI-OK")
  })
})
