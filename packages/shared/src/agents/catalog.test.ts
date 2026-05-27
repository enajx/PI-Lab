import { describe, expect, test } from "vitest"
import { BUILTIN_AGENTS, DEFAULT_AGENT_ID, getAgent, listAgents } from "./catalog"

describe("agent catalog", () => {
  test("ships Claude Code and Codex by default", () => {
    expect(BUILTIN_AGENTS.map((agent) => agent.id)).toEqual(["claude-code", "codex"])
  })
  test("the default agent exists in the catalog", () => {
    expect(getAgent(DEFAULT_AGENT_ID)).toBeDefined()
  })
  test("every entry has a launchable command and a detect binary", () => {
    for (const agent of listAgents()) {
      expect(agent.command.length).toBeGreaterThan(0)
      expect(agent.detect.length).toBeGreaterThan(0)
    }
  })
  test("unknown id returns undefined", () => {
    expect(getAgent("not-an-agent")).toBeUndefined()
  })
})
