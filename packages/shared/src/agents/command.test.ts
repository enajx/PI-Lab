import fc from "fast-check"
import { describe, expect, test } from "vitest"
import { BUILTIN_AGENTS, getAgent, type TerminalAgent } from "./catalog"
import { buildLaunchArgv, buildNonInteractiveLaunchArgv } from "./command"

test("one-shot launches place saved defaults before the prompt and after Codex exec", () => {
  const codex = getAgent("codex")
  const claude = getAgent("claude-code")
  if (!codex || !claude) throw new Error("Missing built-in agent")
  const options = { model: "custom-model", effort: "high" }
  expect(buildNonInteractiveLaunchArgv(codex, "prompt", options)).toEqual([
    "codex",
    "exec",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    "custom-model",
    "--config",
    'model_reasoning_effort="high"',
    "prompt",
  ])
  expect(buildNonInteractiveLaunchArgv(claude, "prompt", options)).toEqual([
    "claude",
    "--dangerously-skip-permissions",
    "--model",
    "custom-model",
    "--effort",
    "high",
    "-p",
    "prompt",
  ])
})

describe("buildLaunchArgv", () => {
  test("applies provider model and effort before the prompt without shell interpolation", () => {
    const codex = getAgent("codex")
    const claude = getAgent("claude-code")
    if (!codex || !claude) throw new Error("Missing built-in agent")
    expect(
      buildLaunchArgv(codex, { model: "custom model", effort: "high", args: ["hello"] }),
    ).toEqual([
      "codex",
      ...(codex.defaultArgs ?? []),
      "--model",
      "custom model",
      "--config",
      'model_reasoning_effort="high"',
      "hello",
    ])
    expect(buildLaunchArgv(claude, { model: "opus", effort: "medium" })).toEqual([
      "claude",
      ...(claude.defaultArgs ?? []),
      "--model",
      "opus",
      "--effort",
      "medium",
    ])
  })
  test("launches the agent's binary", () => {
    const agent = getAgent("claude-code")
    if (!agent) throw new Error("claude-code missing from catalog")
    expect(buildLaunchArgv(agent)).toEqual(["claude", "--dangerously-skip-permissions"])
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

describe("buildNonInteractiveLaunchArgv", () => {
  test("uses Claude print mode and preserves the prompt as one exact argv value", () => {
    const prompt = "review this; $(touch /tmp/never) && echo nope"
    expect(
      buildNonInteractiveLaunchArgv(
        {
          id: "claude-code",
          label: "Claude Code",
          command: "/custom/claude",
          detect: "claude",
          defaultArgs: ["--model", "sonnet"],
        },
        prompt,
      ),
    ).toEqual(["/custom/claude", "--model", "sonnet", "-p", prompt])
  })

  test("uses Codex exec mode and preserves the prompt as one exact argv value", () => {
    const prompt = "fix `README.md` | tee leaked"
    expect(
      buildNonInteractiveLaunchArgv(
        {
          id: "codex",
          label: "Codex",
          command: "codex",
          detect: "codex",
        },
        prompt,
      ),
    ).toEqual([
      "codex",
      "exec",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      prompt,
    ])
  })

  test("rejects harnesses without a supported one-shot contract", () => {
    expect(() =>
      buildNonInteractiveLaunchArgv(
        {
          id: "future-agent",
          label: "Future Agent",
          command: "future-agent",
          detect: "future-agent",
        },
        "go",
      ),
    ).toThrow(/does not support non-interactive workflows/i)
  })
})
