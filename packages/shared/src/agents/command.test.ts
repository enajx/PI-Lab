import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { BUILTIN_AGENTS, getAgent, type TerminalAgent } from "./catalog"
import { buildLaunchArgv } from "./command"

describe("buildLaunchArgv", () => {
  test("launches the agent's binary", () => {
    const agent = getAgent("claude-code")
    if (!agent) throw new Error("claude-code missing from catalog")
    expect(buildLaunchArgv(agent)).toEqual(["claude"])
  })
  test("appends default args then extra args, in order", () => {
    const agent: TerminalAgent = {
      id: "x",
      label: "X",
      command: "x",
      detect: "x",
      defaultArgs: ["--default"],
    }
    expect(buildLaunchArgv(agent, { args: ["--extra", "value"] })).toEqual([
      "x",
      "--default",
      "--extra",
      "value",
    ])
  })
  test("every built-in agent's argv starts with its command", () => {
    for (const agent of BUILTIN_AGENTS) {
      expect(buildLaunchArgv(agent)[0]).toBe(agent.command)
    }
  })

  // Property-based: invariants over all agents and arg lists.
  const agentArb = fc.record({
    id: fc.string(),
    label: fc.string(),
    command: fc.string({ minLength: 1 }),
    detect: fc.string(),
    defaultArgs: fc.array(fc.string()),
  })

  test("argv[0] is always the command", () => {
    fc.assert(
      fc.property(
        agentArb,
        fc.array(fc.string()),
        (agent, args) => buildLaunchArgv(agent, { args })[0] === agent.command,
      ),
    )
  })
  test("preserves default args then extra args, in order and length", () => {
    fc.assert(
      fc.property(agentArb, fc.array(fc.string()), (agent, args) => {
        const argv = buildLaunchArgv(agent, { args })
        const expected = [agent.command, ...agent.defaultArgs, ...args]
        return argv.length === expected.length && argv.every((value, i) => value === expected[i])
      }),
    )
  })
})
