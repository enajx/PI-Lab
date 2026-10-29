import { afterEach, expect, test } from "vitest"
import { createHarness, type Harness } from "../testHarness"

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
})

test("launch defaults persist per provider and reject unsupported effort values", async () => {
  harness = await createHarness([], { git: false, daemon: "lazy" })
  expect((await harness.caller.settings.get()).agents.launchDefaults).toEqual({})
  const launchDefaults = {
    codex: { model: "test-model", effort: "high" },
    "claude-code": { model: "opus" },
  }
  await harness.caller.settings.updateAgents({ launchDefaults })
  await harness.caller.settings.updateAgents({ projectConfigStorage: "both" })
  expect((await harness.caller.settings.get()).agents.launchDefaults).toEqual(launchDefaults)
  await harness.caller.settings.updateAgents({ launchDefaults: { codex: { model: "" } } })
  expect((await harness.caller.settings.get()).agents.launchDefaults).toEqual({
    codex: { model: "", effort: "high" },
    "claude-code": { model: "opus" },
  })
  await expect(
    harness.caller.settings.updateAgents({ launchDefaults: { codex: { effort: "bogus" } } }),
  ).rejects.toThrow()
})

test("legacy default initialization cannot overwrite an explicit Settings selection", async () => {
  harness = await createHarness([], { git: false, daemon: "lazy" })
  expect((await harness.caller.settings.get()).agents.defaultAgentId).toBeNull()
  await harness.caller.settings.initializeDefaultAgent({ agentId: "codex" })
  await harness.caller.settings.updateAgents({ defaultAgentId: "claude-code" })
  const duplicate = await harness.caller.settings.initializeDefaultAgent({ agentId: "codex" })
  expect(duplicate.defaultAgentId).toBe("claude-code")
  expect((await harness.caller.settings.get()).agents.defaultAgentId).toBe("claude-code")
})
